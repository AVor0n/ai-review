import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Всё, что зависит от ОС: пути, секреты, «не засыпать», запуск воркера. Остальной код зовёт только этот модуль.
// macOS — как было: Keychain, caffeinate, launchd, ~/Library. Linux (в том числе WSL2) — libsecret или файл, systemd, XDG
export const IS_MAC = process.platform === 'darwin';
export const WORKER_LABEL = 'com.avoronin.pr-reviewer';
export const SYSTEMD_UNIT = 'pr-reviewer';

const home = homedir();
const xdg = (variable, fallback) => process.env[variable] || join(home, fallback);

export const DATA_DIR = IS_MAC ? join(home, 'Library/Application Support/pr-reviewer') : join(xdg('XDG_DATA_HOME', '.local/share'), 'pr-reviewer');
export const LOG_DIR = IS_MAC ? join(home, 'Library/Logs/pr-reviewer') : join(xdg('XDG_STATE_HOME', '.local/state'), 'pr-reviewer');
export const CONFIG_DIR = IS_MAC ? DATA_DIR : join(xdg('XDG_CONFIG_HOME', '.config'), 'pr-reviewer');
// Служебные клоны и рабочие папки на обеих системах в одном месте
export const GIT_ROOT = join(home, '.pr-reviewer');

const has = (command) => spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;

// Секреты. Значения не печатаются и не пишутся в журнал: наружу только «есть / нет» и где хранится
const SECRETS_FILE = join(CONFIG_DIR, 'secrets.json');

const readSecretsFile = () => {
    try {
        return JSON.parse(readFileSync(SECRETS_FILE, 'utf8'));
    } catch {
        return {};
    }
};

const fileKey = (service, account) => `${service}\u0000${account ?? ''}`;

const fromFile = (service, account) => {
    const secrets = readSecretsFile();
    if (account != null) return secrets[fileKey(service, account)] ?? null;
    const match = Object.keys(secrets).find((key) => key.split('\u0000')[0] === service);
    return match ? secrets[match] : null;
};

const toFile = (service, account, value) => {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const path = `${SECRETS_FILE}.tmp`;
    writeFileSync(path, `${JSON.stringify({ ...readSecretsFile(), [fileKey(service, account)]: value }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    renameSync(path, SECRETS_FILE);
};

// account — как в Keychain: у Bitbucket это email, у моделей не нужен (ищется по одному service)
export const readSecret = (service, account = null) => {
    if (IS_MAC) {
        try {
            return execFileSync('security', ['find-generic-password', '-s', service, ...(account != null ? ['-a', account] : []), '-w'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
        } catch {
            return null;
        }
    }
    // В WSL обычно нет Secret Service: secret-tool есть, но падает — тогда файл
    if (has('secret-tool')) {
        const result = spawnSync('secret-tool', ['lookup', 'service', service, ...(account != null ? ['account', account] : [])], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 10_000,
        });
        if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
    }
    return fromFile(service, account);
};

// Возвращает, куда сохранено: keychain, libsecret или file
export const writeSecret = (service, account, value) => {
    if (IS_MAC) {
        // Значение идёт аргументом: интерактивный ввод `security -w` обрезает его до 128 символов
        execFileSync('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-T', '/usr/bin/security', '-w', value], { stdio: 'ignore' });
        return 'keychain';
    }
    if (has('secret-tool')) {
        const result = spawnSync('secret-tool', ['store', '--label', `PR Reviewer: ${service}`, 'service', service, 'account', account], {
            input: value,
            stdio: ['pipe', 'ignore', 'ignore'],
            timeout: 10_000,
        });
        if (result.status === 0) return 'libsecret';
    }
    toFile(service, account, value);
    return 'file';
};

export const secretStoreHint = IS_MAC ? 'Keychain' : `libsecret или ${SECRETS_FILE}`;

// Не засыпать, пока жив процесс: caffeinate на macOS, systemd-inhibit на Linux. В WSL сон задаёт Windows
export const keepAwake = (pid = process.pid) => {
    if (IS_MAC) {
        spawn('caffeinate', ['-i', '-w', String(pid)], { stdio: 'ignore', detached: true }).unref();
    } else if (has('systemd-inhibit')) {
        spawn('systemd-inhibit', ['--what=idle:sleep', '--who=PR Reviewer', '--why=Идёт ревью', '--mode=block', 'tail', `--pid=${pid}`, '-f', '/dev/null'], {
            stdio: 'ignore',
            detached: true,
        }).unref();
    }
};

// «Запустить сейчас»: launchd на macOS, systemd user service на Linux
export const kickstartWorker = () =>
    IS_MAC
        ? execFileSync('launchctl', ['kickstart', `gui/${process.getuid()}/${WORKER_LABEL}`])
        : execFileSync('systemctl', ['--user', '--no-block', 'start', `${SYSTEMD_UNIT}.service`]);
