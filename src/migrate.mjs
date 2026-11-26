import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, loadConfig, readJson, saveConfig, writeJson } from './store.mjs';

// Однократный перенос в config.json значений, которые до #40 были зашиты в код: шаблон веток, репозитории QA,
// префикс для показа. Чтобы у пользователя ничего не поменялось, значения выводятся из его же данных —
// имён проекта в коде нет. Новая установка (нет state.json) ничего не получает: у неё общие умолчания
const MARKER = join(DATA_DIR, 'migrations.json');
const KEY = /([A-Z][A-Z0-9]+)-\d+/i;

// Самый частый ключ задачи в ветках открытых PR: KEY-\d+
const branchPattern = (branches) => {
    const counts = {};
    for (const branch of branches) {
        const key = KEY.exec(branch)?.[1]?.toUpperCase();
        if (key) counts[key] = (counts[key] ?? 0) + 1;
    }
    const [top] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return top ? `${top[0]}-\\d+` : null;
};

// Общий префикс всех репозиториев до последнего дефиса: у двух и больше репозиториев одного проекта он и отрезался при показе
const commonPrefix = (slugs) => {
    if (slugs.length < 2) return null;
    let prefix = slugs[0];
    for (const slug of slugs) while (!slug.startsWith(prefix)) prefix = prefix.slice(0, -1);
    const dash = prefix.lastIndexOf('-');
    return dash > 0 ? prefix.slice(0, dash + 1) : null;
};

// Фронтенд для QA — репозиторий, по которому уже были тестирования; бэкенд — его пара с backend вместо frontend
const qaRepos = (slugs, testedRepos) => {
    const counts = {};
    for (const repo of testedRepos) if (slugs.includes(repo)) counts[repo] = (counts[repo] ?? 0) + 1;
    const [frontend] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? [];
    if (!frontend) return null;
    const backend = frontend.replace(/frontend/i, (word) => (word === 'FRONTEND' ? 'BACKEND' : word === 'Frontend' ? 'Backend' : 'backend'));
    return backend !== frontend && slugs.includes(backend) ? { frontend, backend } : { frontend };
};

// Чистая часть: что дописать в конфиг. null — ничего
export const projectNamesPatch = (config, { branches, testedRepos }) => {
    const slugs = config.repos.map((repo) => repo.slug);
    const patch = {};
    if (!config.branchPattern) {
        const pattern = branchPattern(branches);
        if (pattern) patch.branchPattern = pattern;
    }
    if (!config.qa?.frontend) {
        const repos = qaRepos(slugs, testedRepos);
        if (repos) patch.qa = { ...config.qa, ...repos };
    }
    if (config.displayPrefix === undefined) {
        const prefix = commonPrefix(slugs);
        if (prefix) patch.displayPrefix = prefix;
    }
    return Object.keys(patch).length ? patch : null;
};

const snapshotBranches = (slugs) => slugs.flatMap((slug) => (readJson(join(DATA_DIR, 'prs', `${slug}.json`), null)?.prs ?? []).map((pr) => pr.source ?? ''));

const testedRepos = () => {
    const dir = join(DATA_DIR, 'qa', 'state');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.replace(/__\d+\.json$/, ''));
};

export const runMigrations = ({ log = () => {} } = {}) => {
    const done = readJson(MARKER, {});
    if (done.projectNames) return;
    // Новая установка — общие умолчания, переносить нечего
    if (existsSync(join(DATA_DIR, 'state.json'))) {
        const config = loadConfig();
        const patch = projectNamesPatch(config, { branches: snapshotBranches(config.repos.map((repo) => repo.slug)), testedRepos: testedRepos() });
        if (patch) {
            saveConfig({ ...config, ...patch });
            log(`настройки: имена проекта перенесены в config.json — ${Object.keys(patch).join(', ')}`);
        }
    }
    writeJson(MARKER, { ...done, projectNames: new Date().toISOString() });
};
