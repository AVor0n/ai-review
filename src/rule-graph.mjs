import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveCommit } from './git.mjs';
import { TOOL_DIR, appendSpend, log, readJson, writeJson } from './store.mjs';

// Граф кода для исследования подбора правил (B-24). Graphify ставит install.sh в свой venv;
// код разбирается tree-sitter локально, LLM-бэкенды выключены — код никуда не уходит
const run = promisify(execFile);
const VENV = join(homedir(), '.pr-reviewer/graphify-venv');
const GRAPHS_DIR = join(homedir(), '.pr-reviewer/graphs');
const COMMUNITIES_SCRIPT = join(TOOL_DIR, 'scripts/graph-communities.py');
const MAX_AGE_MS = 24 * 3600_000;
const BUILD_TIMEOUT_MS = 15 * 60_000;

export const graphifyInstalled = () => existsSync(join(VENV, 'bin/graphify'));

const graphDir = (slug) => join(GRAPHS_DIR, slug);
const metaFile = (slug) => join(graphDir(slug), 'meta.json');
const communitiesFile = (slug) => join(graphDir(slug), 'communities.json');

const build = async (repo, clone, ref, commit, variants) => {
    const src = join(graphDir(repo.slug), 'src');
    mkdirSync(src, { recursive: true });
    // graphify-out с кэшем разбора оставляем: пересборка тогда инкрементальная
    for (const entry of readdirSync(src)) if (entry !== 'graphify-out') rmSync(join(src, entry), { recursive: true, force: true });
    await run('sh', ['-c', 'git -C "$0" archive "$1" | tar -x -C "$2"', clone, commit, src], { maxBuffer: 64 * 1024 * 1024 });
    const env = { ...process.env, GRAPHIFY_BACKEND: 'none', GRAPHIFY_VIZ_NODE_LIMIT: '1' };
    // --force: после удаления кода в графе меньше узлов, и без флага Graphify отказывается перезаписать граф
    await run(join(VENV, 'bin/graphify'), ['update', '.', '--force'], { cwd: src, env, timeout: BUILD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    const { stdout } = await run(join(VENV, 'bin/python'), ['-I', COMMUNITIES_SCRIPT, join(src, 'graphify-out/graph.json'), variants.join(',')], {
        timeout: BUILD_TIMEOUT_MS,
        maxBuffer: 256 * 1024 * 1024,
    });
    writeJson(communitiesFile(repo.slug), { commit, ...JSON.parse(stdout) }, 0);
    writeJson(metaFile(repo.slug), { ref, commit, variants, builtAt: new Date().toISOString() });
};

// Сообщества файлов основной ветки: { commit, files: {путь: {native, nolibs}} }. Граф перестраивается раз в сутки, если ветка ушла вперёд.
// null — Graphify не установлен или сборка не удалась: подбор по графу в этот раз пропускается
export const loadGraph = async (repo, clone, ref, variants) => {
    if (!graphifyInstalled()) return null;
    const meta = readJson(metaFile(repo.slug), null);
    const commit = resolveCommit(clone, ref);
    const age = meta ? Date.now() - Date.parse(meta.builtAt ?? meta.failedAt) : Infinity;
    // Неудачную сборку не повторяем на каждом PR: следующая попытка — через сутки
    if (meta?.failedAt && age < MAX_AGE_MS) return null;
    const usable = meta?.builtAt && variants.every((variant) => meta.variants?.includes(variant)) && existsSync(communitiesFile(repo.slug));
    if (usable && (meta.commit === commit || age < MAX_AGE_MS)) return readJson(communitiesFile(repo.slug), null);
    const startedAt = Date.now();
    try {
        await build(repo, clone, ref, commit, variants);
        appendSpend('rule-graph', repo.slug, null, null, { costUsd: 0 }, startedAt);
        log(`${repo.slug}: граф кода для подбора правил собран за ${Math.round((Date.now() - startedAt) / 1000)} с`);
        return readJson(communitiesFile(repo.slug), null);
    } catch (error) {
        writeJson(metaFile(repo.slug), { ref, commit, variants, failedAt: new Date().toISOString(), error: error.message.slice(0, 500) });
        throw new Error(`граф кода не собран — ${error.message.split('\n')[0]}`);
    }
};
