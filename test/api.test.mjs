import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// Данные сервиса лежат в HOME: подменяем его до импорта
const home = mkdtempSync(join(tmpdir(), 'pr-reviewer-test-'));
process.env.HOME = home;
// На Linux пути данных идут от XDG-переменных, если они заданы: убираем, чтобы тест не задел настоящие данные
for (const name of ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME']) delete process.env[name];
const { DATA_DIR, LOG_DIR } = await import('../src/platform.mjs');
const { EXPORTS_DIR, createApi, eventType, isLoopback, routeList } = await import('../src/api.mjs');
const { validate } = await import('../src/json-schema.mjs');
const { TOOL_DIR, writeJson } = await import('../src/store.mjs');
const configDir = join(home, 'tool');

const SECRET = 'TOPSECRET-value-123';
const TOKEN = 'test-token-0123456789';
const spec = JSON.parse(readFileSync(join(TOOL_DIR, 'schema/api.openapi.json'), 'utf8'));
const config = { bitbucket: { email: 'me@example.com', keychainService: 'test-bitbucket' }, agents: { claude: { shortName: 'Claude', model: 'm', keychainService: 'test-claude', marker: 'C', signature: 'Claude', timeoutMinutes: 30 } }, repos: [{ workspace: 'team', slug: 'backend', remote: 'git@example.com:team/backend.git' }], intervalMinutes: 5 };
const saved = { secrets: [], configs: [], cli: [] };
let cliResult = { ok: true, output: 'готово' };
let server;
let port;

before(async () => {
    mkdirSync(DATA_DIR, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    server = createApi({
        token: TOKEN,
        configDir,
        loadConfig: () => config,
        saveConfig: (next) => saved.configs.push(next),
        // Подмена хранилища секретов: значение известно только ей, в ответах его быть не должно
        secretStatus: () => [{ id: 'claude', service: 'test-claude', present: true, savedAt: null, value: undefined }].map(({ value, ...rest }) => rest),
        saveSecret: (_, id, value) => {
            saved.secrets.push({ id, value });
            return 'file';
        },
        runCli: async (args) => {
            saved.cli.push(args);
            return cliResult;
        },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
});
after(() => {
    server.close();
    rmSync(home, { recursive: true, force: true });
});

const call = (method, path, { body, token = TOKEN, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, method, path, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
            let text = '';
            res.on('data', (chunk) => (text += chunk));
            res.on('end', () => resolve({ status: res.statusCode, text, json: text && res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : null, headers: res.headers }));
        });
        req.on('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
    });

const responseSchema = (method, path, status = 200) => spec.paths[path][method.toLowerCase()].responses[status].content['application/json'].schema;
const conforms = (method, path, value, status = 200) => validate(responseSchema(method, path, status), value, spec);

test('схема OpenAPI описывает ровно маршруты сервера', () => {
    const documented = Object.entries(spec.paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`));
    assert.deepEqual(documented.filter((entry) => entry !== 'GET /events').sort(), routeList().sort());
});

test('без токена или с чужим токеном — 401', async () => {
    assert.equal((await call('GET', '/health', { token: null })).status, 401);
    assert.equal((await call('GET', '/health', { token: 'wrong' })).status, 401);
    assert.equal((await call('GET', '/health')).status, 200);
});

test('только эта машина: чужой Host и чужой источник — 403; адреса loopback', async () => {
    assert.equal((await call('GET', '/health', { headers: { Host: 'evil.example:8765' } })).status, 403);
    assert.equal((await call('GET', '/health', { headers: { Origin: 'https://evil.example' } })).status, 403);
    const tauri = await call('GET', '/health', { headers: { Origin: 'tauri://localhost' } });
    assert.equal(tauri.headers['access-control-allow-origin'], 'tauri://localhost');
    assert.ok(isLoopback('127.0.0.1') && isLoopback('::1') && isLoopback('::ffff:127.0.0.1'));
    assert.ok(!isLoopback('192.168.1.5') && !isLoopback('10.0.0.2'));
});

test('ответы соответствуют схеме', async () => {
    writeFileSync(join(DATA_DIR, 'status.json'), JSON.stringify({ phase: 'idle', running: [] }));
    const health = await call('GET', '/health');
    assert.deepEqual(conforms('GET', '/health', health.json), []);
    const status = await call('GET', '/status');
    assert.deepEqual(conforms('GET', '/status', status.json), []);
    assert.deepEqual(conforms('GET', '/secrets', (await call('GET', '/secrets')).json), []);
    writeFileSync(join(DATA_DIR, 'stats.jsonl'), [{ at: '2026-11-01T00:00:00Z', repo: 'backend' }, { at: '2026-11-20T00:00:00Z', repo: 'backend' }, { at: '2026-11-21T00:00:00Z', repo: 'frontend' }].map((row) => JSON.stringify(row)).join('\n'));
    const stats = await call('GET', '/stats?since=2026-11-10&repo=backend');
    assert.deepEqual(stats.json.map((row) => row.at), ['2026-11-20T00:00:00Z']);
    assert.equal((await call('GET', '/prs/nope')).status, 404);
    assert.equal((await call('GET', '/nothing')).status, 404);
    assert.equal((await call('DELETE', '/health')).status, 405);
});

test('действия — команды CLI с теми же аргументами, ошибка команды — 409 с причиной', async () => {
    saved.cli.length = 0;
    const done = await call('POST', '/fixes/backend/7/stop');
    assert.equal(done.status, 200);
    assert.deepEqual(conforms('POST', '/fixes/{repo}/{pr}/stop', done.json), []);
    await call('POST', '/reviews', { body: { repo: 'backend', pr: 7, agent: 'claude' } });
    await call('POST', '/qa/backend/7/run', { body: { skip: ['c1', 'c2'], add: ['свой кейс'], note: ' заметка ' } });
    assert.deepEqual(saved.cli, [
        ['fix', 'stop', '--repo', 'backend', '--pr', '7'],
        ['review', '--repo', 'backend', '--pr', '7', '--agent', 'claude'],
        ['qa', 'run', '--repo', 'backend', '--pr', '7', '--skip', 'c1,c2', '--add', 'свой кейс', '--note', 'заметка'],
    ]);
    assert.equal((await call('POST', '/fixes/other/7')).status, 404);
    assert.equal((await call('POST', '/reviews', { body: { repo: 'backend' } })).status, 400);
    cliResult = { ok: false, output: 'Проверяю…\nСейчас идёт ревью — запустите, когда оно закончится' };
    const failed = await call('POST', '/run-now');
    cliResult = { ok: true, output: 'готово' };
    assert.equal(failed.status, 409);
    assert.equal(failed.json.error, 'Сейчас идёт ревью — запустите, когда оно закончится');
    assert.deepEqual(conforms('POST', '/run-now', failed.json, 409), []);
});

test('выгрузка через API без пути или с относительным путём — в папку данных, а не в папку кода', async () => {
    saved.cli.length = 0;
    await call('POST', '/data/export');
    await call('POST', '/data/export', { body: { file: 'mine.tar.gz' } });
    await call('POST', '/data/export', { body: { file: '/tmp/abs.tar.gz' } });
    assert.match(saved.cli[0][2], new RegExp(`^${EXPORTS_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pr-reviewer-export-\\d{4}-\\d{2}-\\d{2}\\.tar\\.gz$`));
    assert.deepEqual(saved.cli.slice(1), [['data', 'export', join(EXPORTS_DIR, 'mine.tar.gz')], ['data', 'export', '/tmp/abs.tar.gz']]);
});

test('настройки проверяются по схеме конфига до сохранения', async () => {
    const bad = await call('PUT', '/config', { body: { ...config, intervalMinutes: 0, unknown: true } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /intervalMinutes/);
    assert.equal(saved.configs.length, 0);
    assert.equal((await call('PUT', '/config', { body: config })).status, 200);
    assert.equal(saved.configs.length, 1);
});

test('значение секрета не попадает ни в ответы, ни в журнал', async () => {
    const put = await call('PUT', '/secrets/claude', { body: { value: SECRET } });
    assert.equal(put.status, 200);
    assert.deepEqual(saved.secrets, [{ id: 'claude', value: SECRET }]);
    assert.ok(!put.text.includes(SECRET));
    for (const path of ['/secrets', '/config', '/health', '/log']) assert.ok(!(await call('GET', path)).text.includes(SECRET), path);
    let log = '';
    try {
        log = readFileSync(join(LOG_DIR, 'worker.log'), 'utf8');
    } catch {}
    assert.ok(!log.includes(SECRET));
    assert.equal((await call('PUT', '/secrets/claude', { body: {} })).status, 400);
    const unknown = await call('PUT', '/secrets/nope', { body: {} });
    assert.equal(unknown.status, 404);
    assert.match(unknown.json.error, /Нет секрета nope/);
});

const collectEvents = (type, count, act) =>
    new Promise((resolve, reject) => {
        const events = [];
        const req = request({ host: '127.0.0.1', port, path: '/events', headers: { Authorization: `Bearer ${TOKEN}` } });
        const timer = setTimeout(() => {
            req.destroy();
            reject(new Error(`за 6 с пришло ${events.length} из ${count}: ${JSON.stringify(events)}`));
        }, 6000);
        req.on('response', (res) => {
            res.on('data', (chunk) => {
                events.push(...String(chunk).split('\n\n').filter((frame) => frame.startsWith('event: change')).map((frame) => JSON.parse(frame.split('data: ')[1]).type).filter((item) => item === type));
                if (events.length >= count) {
                    clearTimeout(timer);
                    req.destroy();
                    resolve(events);
                }
            });
            act();
        });
        req.end();
    });

test('событие config приходит на каждую правку, даже через tmp+rename', async () => {
    // Чужие события от прошлых тестов отсеиваются: ждём ровно две правки конфига
    const events = await collectEvents('config', 2, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        writeJson(join(configDir, 'config.json'), { intervalMinutes: 5 });
        await new Promise((resolve) => setTimeout(resolve, 600));
        writeJson(join(configDir, 'config.json'), { intervalMinutes: 6 });
    });
    assert.deepEqual(events, ['config', 'config']);
});

test('событие приходит после изменения файла данных', async () => {
    const events = [];
    const req = request({ host: '127.0.0.1', port, path: '/events', headers: { Authorization: `Bearer ${TOKEN}` } });
    const received = new Promise((resolve) => {
        req.on('response', (res) => {
            res.on('data', (chunk) => {
                events.push(...String(chunk).split('\n\n').filter((frame) => frame.startsWith('event: change')).map((frame) => JSON.parse(frame.split('data: ')[1])));
                if (events.some((event) => event.type === 'limits')) resolve();
            });
            setTimeout(() => writeFileSync(join(DATA_DIR, 'limits.json'), JSON.stringify({ claude: { usedPercent: 10 } })), 200);
        });
    });
    req.end();
    await Promise.race([received, new Promise((_, reject) => setTimeout(() => reject(new Error('нет события за 5 с')), 5000))]);
    req.destroy();
    assert.ok(events.some((event) => event.type === 'limits'));
});

test('пульс прохода — событие status: иначе приложение считало бы проход зависшим', () => {
    assert.equal(eventType('heartbeat'), 'status');
});

test('повреждённая память — 200 с причиной в broken, без правил', async () => {
    mkdirSync(join(DATA_DIR, 'memory'), { recursive: true });
    writeFileSync(join(DATA_DIR, 'memory/backend.json'), '{ не json');
    const broken = await call('GET', '/memory/backend');
    assert.equal(broken.status, 200);
    assert.deepEqual(conforms('GET', '/memory/{repo}', broken.json), []);
    assert.deepEqual(broken.json.lessons, []);
    assert.match(broken.json.broken, /память backend повреждена/);
    writeFileSync(join(DATA_DIR, 'memory/backend.json'), JSON.stringify({ lessons: [{ id: 'a', text: 'правило', at: '2026-11-01T00:00:00Z' }] }));
    const fine = await call('GET', '/memory/backend');
    assert.equal(fine.json.broken, null);
    assert.equal(fine.json.lessons.length, 1);
});

test('файлы прогона тестирования: картинка отдаётся, выход за папку прогона и чужие типы — 403', async () => {
    const runDir = join(DATA_DIR, 'qa/runs/backend__7/1');
    mkdirSync(join(runDir, 'C1'), { recursive: true });
    writeFileSync(join(runDir, 'C1/shot.png'), 'png-bytes');
    writeFileSync(join(runDir, 'C1/notes.txt'), 'text');
    mkdirSync(join(DATA_DIR, 'qa/state'), { recursive: true });
    writeFileSync(join(DATA_DIR, 'qa/state/backend__7.json'), JSON.stringify({ repo: 'backend', pr: 7, state: 'done', run: { runDir } }));
    const file = await call('GET', '/qa/backend/7/file?path=C1/shot.png');
    assert.equal(file.status, 200);
    assert.equal(file.headers['content-type'], 'image/png');
    assert.equal(file.text, 'png-bytes');
    assert.equal((await call('GET', `/qa/backend/7/file?path=${encodeURIComponent('../../../../state.json')}`)).status, 403);
    assert.equal((await call('GET', '/qa/backend/7/file?path=C1/notes.txt')).status, 403);
    assert.equal((await call('GET', '/qa/backend/7/file?path=C1/none.png')).status, 404);
    assert.equal((await call('GET', '/qa/backend/8/file?path=C1/shot.png')).status, 404);
});

test('задача бэклога: running — только при живом процессе, иначе след прерванного запуска', async () => {
    writeFileSync(join(DATA_DIR, 'backlog-job.json'), JSON.stringify({ kind: 'triage', state: 'running', pid: process.pid }));
    const alive = await call('GET', '/backlog/job');
    assert.deepEqual(conforms('GET', '/backlog/job', alive.json), []);
    assert.equal(alive.json.job.running, true);
    writeFileSync(join(DATA_DIR, 'backlog-job.json'), JSON.stringify({ kind: 'triage', state: 'running', pid: 2 ** 22 + 7 }));
    assert.equal((await call('GET', '/backlog/job')).json.job.running, false);
    writeFileSync(join(DATA_DIR, 'backlog-job.json'), JSON.stringify({ kind: 'learn', state: 'done', pid: process.pid }));
    assert.equal((await call('GET', '/backlog/job')).json.job.running, false);
});

test('config.json из редактора: текст как есть, проверка схемы и защита от перезаписи чужих правок', async () => {
    const file = join(configDir, 'config.json');
    const text = `${JSON.stringify(config, null, 4)}\n`;
    writeFileSync(file, text);
    const opened = await call('GET', '/config/file');
    assert.deepEqual(conforms('GET', '/config/file', opened.json), []);
    assert.equal(opened.json.text, text);
    const edited = text.replace('"intervalMinutes": 5', '"intervalMinutes": 7');
    const savedFile = await call('PUT', '/config/file', { body: { text: edited, modifiedAt: opened.json.modifiedAt } });
    assert.equal(savedFile.status, 200);
    assert.equal(readFileSync(file, 'utf8'), edited);
    assert.equal((await call('PUT', '/config/file', { body: { text: '{ "repos": ', modifiedAt: savedFile.json.modifiedAt } })).status, 400);
    assert.equal((await call('PUT', '/config/file', { body: { text: edited.replace('"intervalMinutes": 7', '"intervalMinutes": "семь"'), modifiedAt: savedFile.json.modifiedAt } })).status, 400);
    const stale = await call('PUT', '/config/file', { body: { text, modifiedAt: '2000-01-01T00:00:00.000Z' } });
    assert.equal(stale.status, 409);
    assert.match(stale.json.error, /Перечитать/);
    assert.equal(readFileSync(file, 'utf8'), edited);
});
