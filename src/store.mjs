import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(homedir(), 'Library/Application Support/pr-reviewer');
export const LOG_DIR = join(homedir(), 'Library/Logs/pr-reviewer');
export const LOG_FILE = join(LOG_DIR, 'worker.log');
export const WORKER_LABEL = 'com.avoronin.pr-reviewer';
// Git-копии — в пути без пробелов: хуки репозиториев (husky `commitlint --edit ${1}`) часто не берут путь в кавычки
export const GIT_ROOT = join(homedir(), '.pr-reviewer');
export const REPOS_DIR = join(GIT_ROOT, 'repos');

const STATE_FILE = join(DATA_DIR, 'state.json');
const STATUS_FILE = join(DATA_DIR, 'status.json');
const STATS_FILE = join(DATA_DIR, 'stats.jsonl');
const OUTCOMES_FILE = join(DATA_DIR, 'outcomes.jsonl');
const SKIPS_FILE = join(DATA_DIR, 'skips.jsonl');
const SPEND_FILE = join(DATA_DIR, 'spend.jsonl');
const PAUSED_FILE = join(DATA_DIR, 'paused');
const PID_FILE = join(DATA_DIR, 'worker.pid');
const PRS_DIR = join(DATA_DIR, 'prs');
const RUN_REQUEST_FILE = join(DATA_DIR, 'run-requested');
const QUEUE_DIR = join(DATA_DIR, 'queue');
const CONFIG_FILE = join(TOOL_DIR, 'config.json');
const RECENT_LIMIT = 30;

export const loadConfig = () => JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));

export const readJson = (path, fallback) => {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return fallback;
    }
};

// Запись через временный файл: строка состояния читает status.json параллельно и не должна увидеть половину файла
export const writeJson = (path, value, indent = 2) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, indent)}\n`);
    renameSync(`${path}.tmp`, path);
};

export const saveConfig = (config) => writeJson(CONFIG_FILE, config, 4);

const writeLog = (level, parts) => {
    const line = `${new Date().toISOString()} ${level}${parts.join(' ')}\n`;
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line);
    if (process.stdout.isTTY) process.stdout.write(line);
};

export const log = (...parts) => writeLog('', parts);
// Метка ERROR — по ней вкладка «Журнал» выделяет ошибки
export const logError = (...parts) => writeLog('ERROR ', parts);

export const rotateLog = () => {
    try {
        if (statSync(LOG_FILE).size > 5 * 1024 * 1024) renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch {
        // лога ещё нет
    }
};

export const loadState = () => readJson(STATE_FILE, { nextFirst: 'claude', errorStreak: 0, repos: {} });
export const saveState = (state) => writeJson(STATE_FILE, state);

export const loadStatus = () => readJson(STATUS_FILE, { phase: 'idle', current: null, recent: [] });
export const updateStatus = (patch) => writeJson(STATUS_FILE, { ...loadStatus(), ...patch });
export const pushRecent = (entry) => {
    const status = loadStatus();
    writeJson(STATUS_FILE, { ...status, recent: [entry, ...(status.recent ?? [])].slice(0, RECENT_LIMIT) });
};

export const appendJsonl = (path, entry) => {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
};
export const loadJsonl = (path) => {
    try {
        return readFileSync(path, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
    } catch {
        return [];
    }
};

export const appendStats = (entry) => appendJsonl(STATS_FILE, entry);
export const loadStats = () => loadJsonl(STATS_FILE);
export const appendOutcome = (entry) => appendJsonl(OUTCOMES_FILE, entry);
export const loadOutcomes = () => loadJsonl(OUTCOMES_FILE);
// Пропущенные раунды ревью: из них статистика считает экономию
export const appendSkip = (entry) => appendJsonl(SKIPS_FILE, entry);
// Траты служебных запусков моделей, у которых нет своего журнала: память и бэклог.
// У ревью, доработки, архитектурного ревью и тестирования траты в их собственных журналах
export const appendSpend = (kind, repo, agentId, agent, usage, startedAt) =>
    appendJsonl(SPEND_FILE, {
        at: new Date().toISOString(),
        kind,
        repo,
        agent: agentId,
        model: agent?.model ?? null,
        usage,
        durationSec: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null,
    });

export const isPaused = () => existsSync(PAUSED_FILE);
export const setPaused = (paused) => {
    mkdirSync(DATA_DIR, { recursive: true });
    if (paused) writeFileSync(PAUSED_FILE, new Date().toISOString());
    else rmSync(PAUSED_FILE, { force: true });
};

const isAlive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
};

export const readWorkerPid = () => {
    const pid = Number(readJson(PID_FILE, 0));
    return pid && isAlive(pid) ? pid : null;
};

export const acquireLock = () => {
    if (readWorkerPid()) return false;
    writeJson(PID_FILE, process.pid);
    return true;
};

export const releaseLock = () => {
    if (Number(readJson(PID_FILE, 0)) === process.pid) rmSync(PID_FILE, { force: true });
};

// Снимок открытых PR для окна обзора: пишут и воркер, и `sync`, поэтому по файлу на репозиторий
// threads — счётчики тредов по id PR: открытые и закрытые (Resolve в Bitbucket); у PR без комментариев их нет
export const savePrSnapshot = (slug, prs, threads = {}, branches = {}) =>
    writeJson(join(PRS_DIR, `${slug}.json`), {
        fetchedAt: new Date().toISOString(),
        prs: prs.map((pr) => ({
            id: pr.id,
            title: pr.title,
            draft: Boolean(pr.draft),
            author: pr.author?.display_name ?? null,
            updatedOn: pr.updated_on ? new Date(pr.updated_on).toISOString() : null,
            commentCount: pr.comment_count ?? 0,
            openThreads: threads[pr.id]?.open ?? 0,
            resolvedThreads: threads[pr.id]?.resolved ?? 0,
            openRoots: threads[pr.id]?.openRoots ?? [],
            humanComments: threads[pr.id]?.humans ?? [],
            url: pr.links.html.href,
            head: pr.source.commit.hash.slice(0, 12),
            source: pr.source.branch.name,
            destination: pr.destination.branch.name,
            behind: branches[pr.id]?.behind ?? null,
            conflicts: branches[pr.id]?.conflicts ?? null,
        })),
    });
export const removePrSnapshot = (slug) => rmSync(join(PRS_DIR, `${slug}.json`), { force: true });

// Заявка на явное ревью — отдельный файл: окно и воркер пишут очередь одновременно, а так нет гонки за общий файл
const queueFile = ({ repo, pr, agent }) => join(QUEUE_DIR, `${repo}__${pr}__${agent}.json`);
export const enqueueReview = (request) => writeJson(queueFile(request), { ...request, at: new Date().toISOString() });
export const dequeueReview = (request) => rmSync(queueFile(request), { force: true });
export const listQueue = () => {
    try {
        return readdirSync(QUEUE_DIR)
            .filter((name) => name.endsWith('.json'))
            .map((name) => readJson(join(QUEUE_DIR, name), null))
            .filter(Boolean)
            .sort((a, b) => a.at.localeCompare(b.at));
    } catch {
        return [];
    }
};
export const clearQueue = () => rmSync(QUEUE_DIR, { recursive: true, force: true });

// «Запустить сейчас»: метка нужна, чтобы плановое пробуждение не отличалось от ручного только по времени
export const requestRun = () => {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(RUN_REQUEST_FILE, new Date().toISOString());
};
export const takeRunRequest = () => {
    const requested = existsSync(RUN_REQUEST_FILE);
    rmSync(RUN_REQUEST_FILE, { force: true });
    return requested;
};
