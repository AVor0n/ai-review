import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DATA_DIR, GIT_ROOT, IS_MAC } from './platform.mjs';
import { TOOL_DIR } from './store.mjs';

// Перенос данных сервиса на другую машину (Mac → Linux/WSL2): память, статистика, исходы, бэклог, состояние,
// журналы исследований и снимки графов. Без клонов, рабочих папок, секретов и служебных файлов идущего процесса
const FORMAT = 1;
const ROOT = 'pr-reviewer-export';
const SKIP_DATA = new Set(['tmp', 'worker.pid', 'worker.lock', 'heartbeat', 'stop-requested', 'run-requested', 'status.json']);
const SKIP_IN_JOBS = /(^|\/)(queue|workspaces?|tmp)(\/|$)|\.pid$|\.lock$|stop-requested$/;
const CONFIG_FILE = join(TOOL_DIR, 'config.json');
const GRAPHS_DIR = join(GIT_ROOT, 'graphs');

const copyData = (to) =>
    cpSync(DATA_DIR, to, {
        recursive: true,
        filter: (path) => {
            const rel = relative(DATA_DIR, path);
            if (!rel) return true;
            return !SKIP_DATA.has(rel.split('/')[0]) && !SKIP_IN_JOBS.test(rel);
        },
    });

// Графы — только снимки сообществ и метаданные: отчёт исследования пересчитывает по ним подбор; исходники графа строятся заново
const copyGraphs = (to) => {
    if (!existsSync(GRAPHS_DIR)) return;
    for (const slug of readdirSync(GRAPHS_DIR)) {
        for (const name of ['snapshots', 'communities.json', 'meta.json']) {
            const from = join(GRAPHS_DIR, slug, name);
            if (existsSync(from)) cpSync(from, join(to, slug, name), { recursive: true });
        }
    }
};

const size = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => sum + (entry.isDirectory() ? size(join(dir, entry.name)) : statSync(join(dir, entry.name)).size), 0);

export const exportData = (file) => {
    if (!existsSync(DATA_DIR)) throw new Error(`Нет данных сервиса в ${DATA_DIR}`);
    const target = resolve(file);
    const work = mkdtempSync(join(tmpdir(), 'pr-reviewer-export-'));
    try {
        const root = join(work, ROOT);
        copyData(join(root, 'data'));
        copyGraphs(join(root, 'graphs'));
        if (existsSync(CONFIG_FILE)) cpSync(CONFIG_FILE, join(root, 'config.json'));
        writeFileSync(join(root, 'manifest.json'), `${JSON.stringify({ format: FORMAT, exportedAt: new Date().toISOString(), platform: process.platform, dataDir: DATA_DIR }, null, 2)}\n`);
        const bytes = size(root);
        // Без расширенных атрибутов macOS: GNU tar на Linux ругается на каждый такой заголовок
        execFileSync('tar', ['-czf', target, ...(IS_MAC ? ['--no-mac-metadata', '--no-xattrs', '--no-fflags'] : []), '-C', work, ROOT], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
        return { file: target, bytes, archiveBytes: statSync(target).size };
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
};

// Пути с другой машины: в config.json они перестанут работать, их нужно поправить руками
export const foreignPaths = (value, path = '') => {
    if (typeof value === 'string') {
        const foreign = IS_MAC ? /^(\/home\/|\/mnt\/[a-z]\/)/ : /^(\/Users\/|\/Applications\/|\/Volumes\/)|\/Library\//;
        return foreign.test(value) ? [{ path, value }] : [];
    }
    if (Array.isArray(value)) return value.flatMap((item, index) => foreignPaths(item, `${path}[${index}]`));
    if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => foreignPaths(item, path ? `${path}.${key}` : key));
    return [];
};

// Импорт не затирает данные: если на машине уже есть состояние или config.json, нужен --force
export const importData = (file, { force = false } = {}) => {
    const source = resolve(file);
    if (!existsSync(source)) throw new Error(`Нет файла ${source}`);
    if (!force && existsSync(join(DATA_DIR, 'state.json'))) throw new Error(`В ${DATA_DIR} уже есть данные сервиса — перезаписать: --force`);
    if (!force && existsSync(CONFIG_FILE)) throw new Error(`${CONFIG_FILE} уже есть — перезаписать: --force`);
    const work = mkdtempSync(join(tmpdir(), 'pr-reviewer-import-'));
    try {
        execFileSync('tar', ['-xzf', source, '-C', work]);
        const root = join(work, ROOT);
        const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
        if (manifest.format !== FORMAT) throw new Error(`Архив формата ${manifest.format}, эта версия читает ${FORMAT}`);
        mkdirSync(DATA_DIR, { recursive: true });
        cpSync(join(root, 'data'), DATA_DIR, { recursive: true, force: true });
        if (existsSync(join(root, 'graphs'))) cpSync(join(root, 'graphs'), GRAPHS_DIR, { recursive: true, force: true });
        let foreign = [];
        if (existsSync(join(root, 'config.json'))) {
            cpSync(join(root, 'config.json'), CONFIG_FILE);
            foreign = foreignPaths(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')));
        }
        return { manifest, dataDir: DATA_DIR, config: existsSync(join(root, 'config.json')) ? CONFIG_FILE : null, foreign };
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
};
