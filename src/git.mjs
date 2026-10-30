import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPOS_DIR } from './store.mjs';

export const INPUT_DIR_NAME = '.pr-review';

// Сеть может пропасть посреди fetch (сон Mac, смена VPN): без этого ssh ждёт данных из мёртвого соединения
// часами, и вместе с ним стоит весь сервис. Keepalive рвёт такое соединение примерно за минуту.
// Переменные наследуют все дочерние git — и ревью, и доработка с её push; свой GIT_SSH_COMMAND пользователя не трогаем
process.env.GIT_SSH_COMMAND ??= 'ssh -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4';
process.env.GIT_HTTP_LOW_SPEED_LIMIT ??= '1000';
process.env.GIT_HTTP_LOW_SPEED_TIME ??= '60';

// Предел для сетевых команд на случай, если повиснет что-то кроме соединения
const FETCH_TIMEOUT_MS = 10 * 60_000;
const CLONE_TIMEOUT_MS = 30 * 60_000;

const git = (cwd, args, timeout) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL' });

export const cloneDir = (slug) => join(REPOS_DIR, slug);
export const isCloned = (slug) => existsSync(join(cloneDir(slug), '.git'));

export const ensureClone = (repo) => {
    const dir = cloneDir(repo.slug);
    if (isCloned(repo.slug)) return dir;

    // Клон идёт во временную папку: воркер и окно настроек могут клонировать одновременно,
    // и никто не должен принять недокачанную копию за готовую
    const tmp = join(REPOS_DIR, `.${repo.slug}.${process.pid}.tmp`);
    mkdirSync(REPOS_DIR, { recursive: true });
    rmSync(tmp, { recursive: true, force: true });
    try {
        // Клон с локальной копии экономит сеть; объекты копируются, так что клоны дальше независимы
        if (repo.source && existsSync(repo.source)) {
            git(REPOS_DIR, ['clone', '--quiet', '--no-local', repo.source, tmp], CLONE_TIMEOUT_MS);
            git(tmp, ['remote', 'set-url', 'origin', repo.remote]);
        } else {
            git(REPOS_DIR, ['clone', '--quiet', repo.remote, tmp], CLONE_TIMEOUT_MS);
        }
        appendFileSync(join(tmp, '.git/info/exclude'), `\n/${INPUT_DIR_NAME}/\n`);
        if (isCloned(repo.slug)) {
            rmSync(tmp, { recursive: true, force: true });
            return dir;
        }
        rmSync(dir, { recursive: true, force: true });
        renameSync(tmp, dir);
    } catch (error) {
        rmSync(tmp, { recursive: true, force: true });
        if (isCloned(repo.slug)) return dir;
        throw new Error(`не удалось клонировать ${repo.remote}: ${(error.stderr?.toString() || error.message).trim()}`);
    }
    return dir;
};

export const removeClone = (slug) => rmSync(cloneDir(slug), { recursive: true, force: true });

export const originOf = (dir) => {
    const result = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
};

const STALE_LOCK_MS = 10 * 60_000;
const LOCK_ERROR = /cannot lock ref|Unable to create .*\.lock/;

// Блокировку, брошенную прерванным git (воркер выгрузили посреди fetch), git сам не снимает и дальше падает на ней
const removeStaleLocks = (dir) => {
    const walk = (path) => {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            const child = join(path, entry.name);
            if (entry.isDirectory() && entry.name !== 'objects') walk(child);
            else if (entry.name.endsWith('.lock') && Date.now() - statSync(child).mtimeMs > STALE_LOCK_MS) rmSync(child, { force: true });
        }
    };
    try {
        walk(join(dir, '.git'));
    } catch {
        // клона ещё нет или он меняется — fetch сам скажет, что не так
    }
};

// fetch --prune удаляет устаревшие ветки одной транзакцией; ветки, различающиеся только регистром (R и r),
// на нечувствительной к регистру APFS дают один и тот же файл блокировки, и вся транзакция падает. По одной — проходит
const pruneOneByOne = (dir) => {
    const dryRun = spawnSync('git', ['remote', 'prune', '--dry-run', 'origin'], { cwd: dir, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    for (const [, ref] of (dryRun.stdout ?? '').matchAll(/\[would prune\] (\S+)/g)) {
        spawnSync('git', ['update-ref', '-d', `refs/remotes/${ref}`], { cwd: dir });
    }
};

export const fetchOrigin = (dir) => {
    removeStaleLocks(dir);
    // Иначе fetch запускает gc (в новых git — maintenance) в фоне, тот держит блокировки ссылок, и следующий fetch на них падает
    git(dir, ['config', 'gc.autoDetach', 'false']);
    git(dir, ['config', 'maintenance.autoDetach', 'false']);
    try {
        git(dir, ['fetch', '--quiet', '--prune', 'origin'], FETCH_TIMEOUT_MS);
    } catch (error) {
        if (!LOCK_ERROR.test(error.stderr?.toString() ?? '')) throw error;
        git(dir, ['fetch', '--quiet', 'origin'], FETCH_TIMEOUT_MS);
        pruneOneByOne(dir);
    }
};

export const resolveCommit = (dir, ref) => {
    const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: dir, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
};

// Насколько ветка PR отстала от базы и сольётся ли без конфликтов. merge-tree сливает в памяти, рабочую копию не трогает;
// конфликт слияния почти всегда означает и конфликт rebase. Без нужных ссылок в клоне возвращает null
export const branchStatus = (dir, head, base) => {
    const headCommit = resolveCommit(dir, head);
    const baseCommit = resolveCommit(dir, base);
    if (!headCommit || !baseCommit) return null;
    const count = spawnSync('git', ['rev-list', '--count', `${headCommit}..${baseCommit}`], { cwd: dir, encoding: 'utf8' });
    if (count.status !== 0) return null;
    const behind = Number(count.stdout.trim());
    if (!behind) return { behind, conflicts: false };
    const merge = spawnSync('git', ['merge-tree', '--write-tree', '--quiet', baseCommit, headCommit], { cwd: dir });
    return { behind, conflicts: merge.status === 1 };
};

export const checkoutDetached = (dir, commit) => {
    git(dir, ['checkout', '--quiet', '--force', '--detach', commit]);
    git(dir, ['clean', '-fdq']);
};

export const isAncestor = (dir, ancestor, commit) =>
    spawnSync('git', ['merge-base', '--is-ancestor', ancestor, commit], { cwd: dir }).status === 0;

const DIFF_ARGS = ['diff', '--no-color', '--no-ext-diff', '-M', '-U3', '--src-prefix=a/', '--dst-prefix=b/'];

// Шумные файлы (lock-файлы, сгенерированное) вырезаются из диффа: лишние токены и ложные замечания
const pathspec = (exclude) => (exclude.length ? ['--', '.', ...exclude.map((pattern) => `:(exclude,glob)${pattern}`)] : []);

export const prDiff = (dir, destinationBranch, commit, exclude = []) => {
    const base = git(dir, ['merge-base', `origin/${destinationBranch}`, commit]).trim();
    return git(dir, [...DIFF_ARGS, base, commit, ...pathspec(exclude)]);
};

export const rangeDiff = (dir, from, to, exclude = []) => git(dir, [...DIFF_ARGS, from, to, ...pathspec(exclude)]);

// Отпечаток изменений PR без учёта номеров строк и пробелов: после rebase на свежий develop он не меняется
export const patchId = (dir, diff) => {
    if (!diff.trim()) return null;
    const result = spawnSync('git', ['patch-id', '--stable'], { cwd: dir, input: diff, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    return result.status === 0 ? result.stdout.split(' ')[0] || null : null;
};
