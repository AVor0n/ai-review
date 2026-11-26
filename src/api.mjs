import { execFile, spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { lessonUsage } from './memory-review.mjs';
import { loadQaState } from './qa.mjs';
import { loadMemoryHistory, readMemory } from './memory.mjs';
import { validate } from './json-schema.mjs';
import { DATA_DIR, GIT_ROOT, LOG_DIR } from './platform.mjs';
import { saveSecret, secretStatus, secretTargets } from './secrets.mjs';
import { TOOL_DIR, loadJsonl, readJson, writeJson } from './store.mjs';

// Локальный HTTP API для приложения в трее (B-29). Чтение — те же файлы и модули, что у CLI; действия — вызов самого CLI,
// чтобы правила вроде «прервать только этот PR» жили в одном месте. Слушает только 127.0.0.1, каждый запрос — с токеном
export const DEFAULT_PORT = 8765;
export const TOKEN_FILE = join(DATA_DIR, 'api-token');
export const EXPORTS_DIR = join(DATA_DIR, 'exports');
const CONFIG_FILE = join(TOOL_DIR, 'config.json');
const CONFIG_SCHEMA = join(TOOL_DIR, 'schema/config.schema.json');
const CLI = join(TOOL_DIR, 'src/cli.mjs');
const ACTION_TIMEOUT_MS = 10 * 60_000;
// Источники приложения Tauri: macOS и Linux — tauri://localhost, Windows (WebView2) — http(s)://tauri.localhost
// Плюс dev-сборка приложения (страница Vite из tauri.conf.json devUrl): без токена API ей всё равно ничего не отдаст
const TAURI_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', 'http://localhost:1420'];

export const ensureToken = () => {
    if (!existsSync(TOKEN_FILE)) {
        mkdirSync(DATA_DIR, { recursive: true });
        writeFileSync(TOKEN_FILE, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
    }
    chmodSync(TOKEN_FILE, 0o600);
    return readFileSync(TOKEN_FILE, 'utf8').trim();
};

export const isLoopback = (address) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
// Host проверяется от DNS rebinding: страница с чужого домена, который смотрит на 127.0.0.1, токена всё равно не знает, но и до ответа не доходит
const isLocalHost = (host = '') => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const readDirStates = (dir) =>
    existsSync(dir)
        ? readdirSync(dir)
              .filter((name) => name.endsWith('.json'))
              .map((name) => readJson(join(dir, name), null))
              .filter(Boolean)
        : [];

// Длинные журналы — с фильтром: окну на 7/30/90 дней не нужен весь stats.jsonl
const journal = (file, query) => {
    const since = query.get('since');
    const until = query.get('until');
    const repo = query.get('repo');
    const rows = loadJsonl(join(DATA_DIR, file)).filter((row) => (!since || row.at >= since) && (!until || row.at < until) && (!repo || row.repo === repo));
    const limit = Number(query.get('limit'));
    return limit > 0 ? rows.slice(-limit) : rows;
};

const isAlive = (pidFile) => {
    const pid = Number(readFileSafe(pidFile));
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

const readFileSafe = (path) => {
    try {
        return readFileSync(path, 'utf8').trim();
    } catch {
        return null;
    }
};

const tailLines = (file, count) => {
    const text = readFileSafe(file) ?? '';
    return text.split('\n').filter(Boolean).slice(-count);
};

const version = () => {
    const pkg = readJson(join(TOOL_DIR, 'package.json'), {});
    const commit = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: TOOL_DIR, encoding: 'utf8' }).stdout?.trim() || null;
    const dirty = Boolean(spawnSync('git', ['status', '--porcelain', '--', 'src', 'schema'], { cwd: TOOL_DIR, encoding: 'utf8' }).stdout?.trim());
    return { version: pkg.version, commit, dirty };
};

const repoParam = (params, config) => {
    if (!config.repos.some((repo) => repo.slug === params.repo)) throw new ApiError(404, `Репозиторий ${params.repo} не подключён`);
    return params.repo;
};

const prParam = (params) => {
    const pr = Number(params.pr);
    if (!Number.isInteger(pr) || pr <= 0) throw new ApiError(400, `Неверный номер PR: ${params.pr}`);
    return String(pr);
};

const field = (body, name, type = 'string') => {
    const value = body?.[name];
    if (type === 'string' && (typeof value !== 'string' || !value.trim())) throw new ApiError(400, `Нужно поле ${name}`);
    if (type === 'integer' && !Number.isInteger(value)) throw new ApiError(400, `Нужно целое число в поле ${name}`);
    return type === 'string' ? value.trim() : value;
};

// Файл отдаётся, только если он внутри папки последнего прогона PR и это картинка или видео Playwright
const MEDIA_TYPES = { '.png': 'image/png', '.webm': 'video/webm' };
const qaFile = (repo, pr, path) => {
    const runDir = loadQaState(repo, Number(pr))?.run?.runDir;
    if (!runDir) throw new ApiError(404, 'У PR нет прогона тестирования');
    if (!path) throw new ApiError(400, 'Нужен параметр path — путь файла в папке прогона');
    const full = resolve(runDir, path);
    const type = MEDIA_TYPES[extname(full).toLowerCase()];
    if (!full.startsWith(resolve(runDir) + sep) || !type) throw new ApiError(403, 'Отдаются только скриншоты и видео из папки прогона');
    if (!existsSync(full) || !statSync(full).isFile()) throw new ApiError(404, `Нет файла ${path}`);
    return { full, type };
};

// Действие = команда CLI: те же проверки, те же тексты ошибок, та же логика прерывания
const cliAction = (build, { json = false } = {}) => ({ action: build, json });

const routes = (deps) => {
    const { loadConfig } = deps;
    const memoryJson = (slug) => {
        const { usage, since, runs } = lessonUsage(slug);
        // Повреждённая память — не ошибка запроса: правил нет, причина в broken. Журнал сервиса при этом не трогаем — его ведёт ревью
        const { lessons, broken } = readMemory(slug);
        return { since, runs, broken: broken ?? null, lessons: lessons.map((lesson) => ({ ...lesson, usage: usage.get(lesson.id) ?? null })) };
    };
    return [
        // Чтение
        { method: 'GET', path: '/health', read: () => ({ ...version(), platform: process.platform, dataDir: DATA_DIR, logDir: LOG_DIR, tokenFile: TOKEN_FILE, cli: join(TOOL_DIR, 'bin', 'pr-reviewer'), worker: { running: isAlive(join(DATA_DIR, 'worker.pid')), heartbeat: readFileSafe(join(DATA_DIR, 'heartbeat')) }, paused: existsSync(join(DATA_DIR, 'paused')), now: new Date().toISOString() }) },
        {
            method: 'GET',
            path: '/status',
            read: () => ({
                ...readJson(join(DATA_DIR, 'status.json'), {}),
                paused: existsSync(join(DATA_DIR, 'paused')),
                workerRunning: isAlive(join(DATA_DIR, 'worker.pid')),
                heartbeat: readFileSafe(join(DATA_DIR, 'heartbeat')),
                queue: readDirStates(join(DATA_DIR, 'queue')),
                workers: { fix: isAlive(join(DATA_DIR, 'fixes/worker.pid')), arch: isAlive(join(DATA_DIR, 'arch/worker.pid')), qa: isAlive(join(DATA_DIR, 'qa/worker.pid')) },
            }),
        },
        { method: 'GET', path: '/state', read: () => readJson(join(DATA_DIR, 'state.json'), {}) },
        { method: 'GET', path: '/prs', read: () => Object.fromEntries(loadConfig().repos.map((repo) => [repo.slug, readJson(join(DATA_DIR, 'prs', `${repo.slug}.json`), null)])) },
        { method: 'GET', path: '/prs/{repo}', read: ({ params }) => readJson(join(DATA_DIR, 'prs', `${repoParam(params, loadConfig())}.json`), null) },
        { method: 'GET', path: '/clones', read: () => Object.fromEntries(loadConfig().repos.map((repo) => [repo.slug, existsSync(join(GIT_ROOT, 'repos', repo.slug, '.git'))])) },
        { method: 'GET', path: '/stats', read: ({ query }) => journal('stats.jsonl', query) },
        { method: 'GET', path: '/outcomes', read: ({ query }) => journal('outcomes.jsonl', query) },
        { method: 'GET', path: '/skips', read: ({ query }) => journal('skips.jsonl', query) },
        { method: 'GET', path: '/spend', read: ({ query }) => journal('spend.jsonl', query) },
        { method: 'GET', path: '/limits', read: () => readJson(join(DATA_DIR, 'limits.json'), {}) },
        { method: 'GET', path: '/fixes', read: () => readDirStates(join(DATA_DIR, 'fixes/state')) },
        { method: 'GET', path: '/fixes/history', read: ({ query }) => journal('fixes.jsonl', query) },
        { method: 'GET', path: '/arch', read: () => readDirStates(join(DATA_DIR, 'arch/state')) },
        { method: 'GET', path: '/arch/history', read: ({ query }) => journal('arch.jsonl', query) },
        { method: 'GET', path: '/arch/{repo}/{pr}/markdown', ...cliAction(({ params, config }) => ['arch', 'show', '--repo', repoParam(params, config), '--pr', prParam(params)]) },
        { method: 'GET', path: '/qa', read: () => readDirStates(join(DATA_DIR, 'qa/state')) },
        { method: 'GET', path: '/qa/history', read: ({ query }) => journal('qa.jsonl', query) },
        { method: 'GET', path: '/qa/{repo}/{pr}/markdown', ...cliAction(({ params, query, config }) => ['qa', 'show', '--repo', repoParam(params, config), '--pr', prParam(params), ...(query.get('plan') === 'true' ? ['--plan'] : [])]) },
        { method: 'GET', path: '/backlog', read: () => readJson(join(DATA_DIR, 'backlog.json'), { items: [] }) },
        { method: 'GET', path: '/backlog/job', read: () => ({ job: readJson(join(DATA_DIR, 'backlog-job.json'), null), scan: readJson(join(DATA_DIR, 'backlog-scan.json'), null) }) },
        { method: 'GET', path: '/backlog/markdown', ...cliAction(({ query }) => ['backlog', 'export', ...(query.get('all') === 'true' ? ['--all'] : [])]) },
        { method: 'GET', path: '/memory/{repo}', read: ({ params }) => memoryJson(repoParam(params, loadConfig())) },
        { method: 'GET', path: '/memory/{repo}/plan', ...cliAction(({ params, config }) => ['memory', 'review', repoParam(params, config), '--show', '--json'], { json: true }) },
        { method: 'GET', path: '/memory/{repo}/history', read: ({ params }) => loadMemoryHistory(repoParam(params, loadConfig())) },
        { method: 'GET', path: '/config', read: () => loadConfig() },
        { method: 'GET', path: '/secrets', read: () => deps.secretStatus(loadConfig()) },
        { method: 'GET', path: '/log', read: ({ query }) => ({ lines: tailLines(join(LOG_DIR, 'worker.log'), Math.min(5000, Number(query.get('lines')) || 500)) }) },
        {
            method: 'GET',
            path: '/models',
            read: () => ({
                cursor: readJson(join(DATA_DIR, 'cursor-models.json'), null),
                codex: readJson(join(homedir(), '.codex/models_cache.json'), null),
            }),
        },

        // Действия
        { method: 'POST', path: '/run-now', ...cliAction(() => ['run-now']) },
        { method: 'POST', path: '/stop', ...cliAction(() => ['stop']) },
        { method: 'POST', path: '/pause', ...cliAction(() => ['pause']) },
        { method: 'POST', path: '/resume', ...cliAction(() => ['resume']) },
        { method: 'POST', path: '/sync', ...cliAction(() => ['sync']) },
        { method: 'POST', path: '/limits/refresh', ...cliAction(() => ['limits']) },
        { method: 'POST', path: '/reviews', ...cliAction(({ body, config }) => ['review', '--repo', repoParam({ repo: field(body, 'repo') }, config), '--pr', prParam({ pr: body?.pr }), '--agent', field(body, 'agent')]) },
        { method: 'POST', path: '/fixes/{repo}/{pr}', ...cliAction(({ params, body, config }) => ['fix', '--repo', repoParam(params, config), '--pr', prParam(params), ...(body?.rebase === true ? ['--rebase'] : [])]) },
        { method: 'POST', path: '/fixes/{repo}/{pr}/stop', ...cliAction(({ params, config }) => ['fix', 'stop', '--repo', repoParam(params, config), '--pr', prParam(params)]) },
        { method: 'POST', path: '/arch/{repo}/{pr}', ...cliAction(({ params, config }) => ['arch', '--repo', repoParam(params, config), '--pr', prParam(params)]) },
        { method: 'POST', path: '/arch/{repo}/{pr}/stop', ...cliAction(({ params, config }) => ['arch', 'stop', '--repo', repoParam(params, config), '--pr', prParam(params)]) },
        {
            method: 'POST',
            path: '/qa/{repo}/{pr}/plan',
            ...cliAction(({ params, body, config }) => ['qa', 'plan', '--repo', repoParam(params, config), '--pr', prParam(params), ...(body?.note?.trim() ? ['--note', body.note.trim()] : [])]),
        },
        {
            method: 'POST',
            path: '/qa/{repo}/{pr}/run',
            ...cliAction(({ params, body, config }) => [
                'qa', 'run', '--repo', repoParam(params, config), '--pr', prParam(params),
                ...(body?.skip?.length ? ['--skip', body.skip.join(',')] : []),
                ...(body?.add ?? []).flatMap((item) => ['--add', String(item)]),
                ...(body?.note?.trim() ? ['--note', body.note.trim()] : []),
            ]),
        },
        { method: 'POST', path: '/qa/{repo}/{pr}/stop', ...cliAction(({ params, config }) => ['qa', 'stop', '--repo', repoParam(params, config), '--pr', prParam(params)]) },
        // Скриншоты и видео прогона для превью и окна просмотра: на Windows файлы лежат в WSL, вебвью их напрямую не видит
        { method: 'GET', path: '/qa/{repo}/{pr}/file', file: ({ params, query, config }) => qaFile(repoParam(params, config), prParam(params), query.get('path')) },
        { method: 'POST', path: '/qa/{repo}/{pr}/save', ...cliAction(({ params, config }) => ['qa', 'save', '--repo', repoParam(params, config), '--pr', prParam(params)]) },
        { method: 'POST', path: '/memory/{repo}/lessons', ...cliAction(({ params, body, config }) => ['memory', 'add', repoParam(params, config), field(body, 'text')]) },
        { method: 'PUT', path: '/memory/{repo}/lessons/{id}', ...cliAction(({ params, body, config }) => ['memory', 'edit', repoParam(params, config), params.id, field(body, 'text')]) },
        { method: 'DELETE', path: '/memory/{repo}/lessons/{id}', ...cliAction(({ params, config }) => ['memory', 'remove', repoParam(params, config), params.id]) },
        { method: 'POST', path: '/memory/{repo}/learn', ...cliAction(({ params, body, config }) => ['memory', 'learn', repoParam(params, config), '--prs', String(body?.prs ?? 100)]) },
        { method: 'POST', path: '/memory/{repo}/review', ...cliAction(({ params, config }) => ['memory', 'review', repoParam(params, config), '--json'], { json: true }) },
        { method: 'DELETE', path: '/memory/{repo}/plan', ...cliAction(({ params, config }) => ['memory', 'review', repoParam(params, config), '--discard']) },
        { method: 'POST', path: '/memory/{repo}/apply', ...cliAction(({ params, config }) => ['memory', 'apply', repoParam(params, config)]) },
        { method: 'POST', path: '/memory/{repo}/restore', ...cliAction(({ params, config }) => ['memory', 'restore', repoParam(params, config)]) },
        {
            method: 'POST',
            path: '/backlog/{id}/{action}',
            ...cliAction(({ params, body }) => {
                if (!['filed', 'drop', 'reopen'].includes(params.action)) throw new ApiError(404, `Нет действия ${params.action}: filed, drop, reopen`);
                return ['backlog', params.action, params.id, ...(body?.text?.trim() ? [body.text.trim()] : [])];
            }),
        },
        {
            method: 'POST',
            path: '/backlog/jobs',
            ...cliAction(({ body }) => {
                if (!['learn', 'triage'].includes(body?.kind)) throw new ApiError(400, 'kind — learn или triage');
                return ['backlog', body.kind, '--background'];
            }),
        },
        { method: 'POST', path: '/backlog/jobs/stop', ...cliAction(() => ['backlog', 'stop']) },
        { method: 'POST', path: '/backlog/close-stale', ...cliAction(() => ['backlog', 'close-stale']) },
        { method: 'PUT', path: '/settings/branches', ...cliAction(({ body }) => ['branches', field(body, 'pattern')]) },
        { method: 'PUT', path: '/settings/interval', ...cliAction(({ body }) => ['interval', String(field(body, 'minutes', 'integer'))]) },
        { method: 'POST', path: '/settings/ignore', ...cliAction(({ body }) => ['ignore', 'add', field(body, 'pattern')]) },
        { method: 'DELETE', path: '/settings/ignore', ...cliAction(({ body }) => ['ignore', 'remove', field(body, 'pattern')]) },
        { method: 'PUT', path: '/tokens/{id}/lifetime', ...cliAction(({ params, body }) => ['token', params.id, body?.days === 0 ? 'never' : String(field(body, 'days', 'integer'))]) },
        {
            method: 'PUT',
            path: '/agents/{id}',
            ...cliAction(({ params, body }) => [
                'agent', 'set', params.id,
                ...(body?.model ? ['--model', String(body.model)] : []),
                ...(body?.effort ? ['--effort', String(body.effort)] : []),
                ...(body?.label ? ['--label', String(body.label)] : []),
                ...(typeof body?.auto === 'boolean' ? ['--auto', body.auto ? 'on' : 'off'] : []),
            ]),
        },
        { method: 'POST', path: '/agents/cursor/models', ...cliAction(() => ['agent', 'models', 'cursor']) },
        { method: 'POST', path: '/repos', ...cliAction(({ body }) => ['repo', 'add', field(body, 'ref'), '--json'], { json: true }) },
        { method: 'POST', path: '/repos/{repo}/clone', ...cliAction(({ params, config }) => ['repo', 'clone', repoParam(params, config)]) },
        { method: 'POST', path: '/repos/{repo}/pause', ...cliAction(({ params, config }) => ['repo', 'pause', repoParam(params, config)]) },
        { method: 'POST', path: '/repos/{repo}/resume', ...cliAction(({ params, config }) => ['repo', 'resume', repoParam(params, config)]) },
        { method: 'DELETE', path: '/repos/{repo}', ...cliAction(({ params, config }) => ['repo', 'remove', repoParam(params, config)]) },
        // CLI сервера запускается из папки кода: без пути или с относительным путём архив с конфигом и памятью лёг бы рядом с кодом
        {
            method: 'POST',
            path: '/data/export',
            ...cliAction(({ body }) => {
                const file = body?.file ? String(body.file) : `pr-reviewer-export-${new Date().toISOString().slice(0, 10)}.tar.gz`;
                return ['data', 'export', isAbsolute(file) ? file : join(EXPORTS_DIR, file)];
            }),
        },
        {
            method: 'PUT',
            path: '/config',
            write: ({ body }) => {
                const errors = validate(JSON.parse(readFileSync(CONFIG_SCHEMA, 'utf8')), body);
                if (errors.length) throw new ApiError(400, `Настройки не сохранены: ${errors.join('; ')}`);
                deps.saveConfig(body);
                return { ok: true };
            },
        },
        {
            method: 'PUT',
            path: '/secrets/{id}',
            write: ({ params, body }) => {
                const known = Object.keys(secretTargets(loadConfig()));
                if (!known.includes(params.id)) throw new ApiError(404, `Нет секрета ${params.id}: ${known.join(', ')}`);
                if (typeof body?.value !== 'string') throw new ApiError(400, 'Нужно поле value');
                try {
                    return { ok: true, store: deps.saveSecret(loadConfig(), params.id, body.value) };
                } catch (error) {
                    throw new ApiError(400, error.message);
                }
            },
        },
    ];
};

// Пути маршрутов — для проверки, что схема OpenAPI описывает ровно их
export const routeList = () => routes({ loadConfig: () => ({ repos: [] }) }).map(({ method, path }) => `${method} ${path}`);

const compile = (path) => new RegExp(`^${path.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)')}$`);

const runCli = (args) =>
    new Promise((resolve) => {
        execFile(process.execPath, [CLI, ...args], { cwd: TOOL_DIR, timeout: ACTION_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
            resolve({ ok: !error, output: `${stdout}${stderr}`.trim() });
        });
    });

const readBody = (req) =>
    new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > 4 * 1024 * 1024) reject(new ApiError(413, 'Слишком большой запрос'));
            else chunks.push(chunk);
        });
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text) return resolve(null);
            try {
                resolve(JSON.parse(text));
            } catch {
                reject(new ApiError(400, 'Тело запроса — не JSON'));
            }
        });
        req.on('error', reject);
    });

// Изменения файлов данных → события SSE. Тип события говорит, какой ресурс перечитать
export const eventType = (rel) => {
    const [head] = rel.split('/');
    // heartbeat — пульс прохода раз в 30 с: по нему приложение понимает, что проход не завис
    if (['status.json', 'paused', 'queue', 'worker.pid', 'heartbeat'].includes(head)) return 'status';
    if (head === 'prs') return 'prs';
    if (head === 'state.json') return 'state';
    if (head === 'limits.json') return 'limits';
    if (head === 'fixes' || head === 'fixes.jsonl') return 'fixes';
    if (head === 'arch' || head === 'arch.jsonl') return 'arch';
    if (head === 'qa' || head === 'qa.jsonl') return 'qa';
    if (head.startsWith('backlog')) return 'backlog';
    if (head === 'memory') return 'memory';
    if (['stats.jsonl', 'outcomes.jsonl', 'skips.jsonl', 'spend.jsonl'].includes(head)) return 'stats';
    if (head === 'cursor-models.json') return 'models';
    return null;
};

const startWatching = (broadcast, configDir) => {
    mkdirSync(DATA_DIR, { recursive: true });
    const pending = new Map();
    const emit = (type) => {
        clearTimeout(pending.get(type));
        pending.set(type, setTimeout(() => broadcast(type), 300));
    };
    const watchers = [
        watch(DATA_DIR, { recursive: true }, (_, name) => {
            const type = name && eventType(String(name).split(/[\\/]/).join('/'));
            if (type) emit(type);
        }),
    ];
    // Следим за папкой, а не за файлом: config.json пишется через tmp+rename, и наблюдатель за файлом остался бы на старом inode
    watchers.push(watch(configDir, (_, name) => String(name) === 'config.json' && emit('config')));
    return () => {
        for (const watcher of watchers) watcher.close();
        for (const timer of pending.values()) clearTimeout(timer);
    };
};

// deps подменяются в тестах: конфиг, секреты и запуск CLI
export const createApi = (overrides = {}) => {
    const deps = {
        loadConfig: () => JSON.parse(readFileSync(CONFIG_FILE, 'utf8')),
        saveConfig: (config) => writeJson(CONFIG_FILE, config, 4),
        secretStatus,
        saveSecret,
        runCli,
        configDir: TOOL_DIR,
        ...overrides,
        token: overrides.token ?? ensureToken(),
    };
    const table = routes(deps).map((route) => ({ ...route, pattern: compile(route.path) }));
    const clients = new Set();
    const expected = Buffer.from(deps.token);
    const allowedOrigins = new Set([...TAURI_ORIGINS, ...(deps.loadConfig().api?.origins ?? [])]);

    const send = (res, status, payload, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
        res.end(JSON.stringify(payload));
    };

    const authorized = (req) => {
        const header = req.headers.authorization ?? '';
        const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7).trim() : '');
        return given.length === expected.length && timingSafeEqual(given, expected);
    };

    const handle = async (req, res) => {
        const origin = req.headers.origin;
        const cors = origin && allowedOrigins.has(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
        if (!isLoopback(req.socket.remoteAddress) || !isLocalHost(req.headers.host)) return send(res, 403, { error: 'API доступен только с этой машины' });
        if (origin && !cors['Access-Control-Allow-Origin']) return send(res, 403, { error: `Источник ${origin} не разрешён` });
        if (req.method === 'OPTIONS') {
            res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' });
            return res.end();
        }
        if (!authorized(req)) return send(res, 401, { error: 'Нужен токен API: заголовок Authorization: Bearer <токен из файла api-token>' }, cors);
        const url = new URL(req.url, 'http://127.0.0.1');

        if (req.method === 'GET' && url.pathname === '/events') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...cors });
            res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
            clients.add(res);
            req.on('close', () => clients.delete(res));
            return;
        }

        const candidates = table.map((route) => ({ route, match: route.pattern.exec(url.pathname) })).filter(({ match }) => match);
        const found = candidates.find(({ route }) => route.method === req.method);
        if (!found) return send(res, candidates.length ? 405 : 404, { error: candidates.length ? 'Метод не поддерживается' : 'Нет такого ресурса' }, cors);
        const params = Object.fromEntries(Object.entries(found.match.groups ?? {}).map(([key, value]) => [key, decodeURIComponent(value)]));
        try {
            const body = req.method === 'GET' ? null : await readBody(req);
            const context = { params, query: url.searchParams, body, config: deps.loadConfig() };
            const { route } = found;
            if (route.read) return send(res, 200, route.read(context) ?? null, cors);
            if (route.file) {
                const { full, type } = route.file(context);
                res.writeHead(200, { 'Content-Type': type, 'Content-Length': statSync(full).size, 'Cache-Control': 'no-store', ...cors });
                return createReadStream(full).pipe(res);
            }
            if (route.write) return send(res, 200, route.write(context), cors);
            const { ok, output } = await deps.runCli(route.action(context));
            if (!ok) return send(res, 409, { error: output.split('\n').filter(Boolean).at(-1) ?? 'Команда не выполнена', output }, cors);
            if (route.json) {
                try {
                    return send(res, 200, JSON.parse(output || 'null'), cors);
                } catch {
                    return send(res, 200, { ok: true, output }, cors);
                }
            }
            return send(res, 200, { ok: true, output }, cors);
        } catch (error) {
            return send(res, error.status ?? 500, { error: error.message }, cors);
        }
    };

    const broadcast = (type) => {
        const frame = `event: change\ndata: ${JSON.stringify({ type, at: new Date().toISOString() })}\n\n`;
        for (const client of clients) client.write(frame);
    };

    const server = createServer((req, res) => {
        handle(req, res).catch((error) => send(res, 500, { error: error.message }));
    });
    let stopWatching = null;
    let keepAlive = null;
    server.on('listening', () => {
        stopWatching = startWatching(broadcast, deps.configDir);
        // Комментарий раз в 25 с держит соединение SSE через прокси и показывает клиенту, что сервер жив
        keepAlive = setInterval(() => {
            for (const client of clients) client.write(': ping\n\n');
        }, 25_000);
    });
    server.on('close', () => {
        stopWatching?.();
        clearInterval(keepAlive);
        for (const client of clients) client.end();
    });
    return server;
};

export const serveApi = (port) => {
    const server = createApi();
    server.listen(port, '127.0.0.1');
    return server;
};

export const apiPort = (config) => config.api?.port ?? DEFAULT_PORT;
