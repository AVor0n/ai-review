import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cloneDir, ensureClone, isCloned, originOf, removeClone } from './git.mjs';
import { refreshSnapshot } from './snapshot.mjs';
import { loadConfig, log, removePrSnapshot, saveConfig } from './store.mjs';

const BITBUCKET_REF = /bitbucket\.org[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/;
const SHORT_REF = /^([\w.-]+)\/([\w.-]+)$/;

export const parseRepoRef = (ref) => {
    const match = BITBUCKET_REF.exec(ref.trim()) ?? SHORT_REF.exec(ref.trim());
    if (!match) throw new Error(`Не понял, что за репозиторий: ${ref}. Нужна ссылка на Bitbucket или workspace/slug`);
    return { workspace: match[1], slug: match[2].toLowerCase() };
};

// Локальная рабочая копия ускоряет первый клон; ищем её рядом с исходниками уже подключённых репозиториев
const findLocalSource = (config, { workspace, slug }) => {
    const parents = new Set(config.repos.filter((repo) => repo.source).map((repo) => dirname(repo.source)));
    for (const parent of parents) {
        const candidate = join(parent, slug);
        if (existsSync(join(candidate, '.git')) && originOf(candidate)?.includes(`${workspace}/${slug}`)) return candidate;
    }
    return null;
};

// Без этого ensureClone молча скачивал бы репозиторий из сети, а в конфиге висел бы мёртвый путь
export const pruneMissingSources = () => {
    const config = loadConfig();
    const missing = config.repos.filter((repo) => repo.source && !existsSync(join(repo.source, '.git')));
    for (const repo of missing) {
        log(`${repo.slug}: локальной копии ${repo.source} больше нет, source убран из config.json`);
        delete repo.source;
    }
    if (missing.length) saveConfig(config);
    return config;
};

export const setRepoPaused = (slug, paused) => {
    const config = loadConfig();
    const repo = config.repos.find((candidate) => candidate.slug === slug);
    if (!repo) throw new Error(`Репозиторий ${slug} не подключён`);
    if (paused) repo.paused = true;
    else delete repo.paused;
    saveConfig(config);
};

export const listRepos = () =>
    pruneMissingSources().repos.map((repo) => ({ ...repo, cloned: isCloned(repo.slug), path: cloneDir(repo.slug) }));

export const addRepo = async (bitbucket, ref, { source } = {}) => {
    const config = pruneMissingSources();
    const parsed = parseRepoRef(ref);
    if (config.repos.some((repo) => repo.workspace === parsed.workspace && repo.slug === parsed.slug)) {
        throw new Error(`${parsed.workspace}/${parsed.slug} уже подключён`);
    }
    // Запрос заодно проверяет, что токен видит репозиторий, — иначе ревью потом молча падало бы каждые 15 минут
    const info = await bitbucket.getRepository(parsed.workspace, parsed.slug);
    const remote = info.links.clone.find((link) => link.name === 'ssh')?.href ?? `git@bitbucket.org:${parsed.workspace}/${info.slug}.git`;
    if (source && !existsSync(join(source, '.git'))) throw new Error(`${source} — не git-репозиторий`);

    const repo = { workspace: parsed.workspace, slug: info.slug, remote };
    const localSource = source ?? findLocalSource(config, repo);
    if (localSource) repo.source = localSource;

    config.repos.push(repo);
    saveConfig(config);
    return repo;
};

export const cloneRepo = async (bitbucket, slug) => {
    const repo = pruneMissingSources().repos.find((candidate) => candidate.slug === slug);
    if (!repo) throw new Error(`Репозиторий ${slug} не подключён`);
    const dir = ensureClone(repo);
    await refreshSnapshot(bitbucket, repo, await bitbucket.listOpenPrs(repo));
    return dir;
};

export const removeRepo = (slug) => {
    const config = loadConfig();
    if (!config.repos.some((repo) => repo.slug === slug)) throw new Error(`Репозиторий ${slug} не подключён`);
    config.repos = config.repos.filter((repo) => repo.slug !== slug);
    saveConfig(config);
    removePrSnapshot(slug);
    removeClone(slug);
};
