import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR, readJson, writeJson } from './store.mjs';

// Проблемы вне скоупа PR: модели находят их по ходу ревью, а команда раз в неделю разбирает и заводит задачи
const BACKLOG_FILE = join(DATA_DIR, 'backlog.json');
const LEVELS = ['P0', 'P1', 'P2', 'P3'];
export const STATUSES = { open: 'ждёт разбора', filed: 'задача заведена', dropped: 'отклонено' };

export const loadBacklog = () => readJson(BACKLOG_FILE, { items: [] }).items;
const saveBacklog = (items) => writeJson(BACKLOG_FILE, { items });

const normalize = (text) =>
    text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();

// Старая проблема всплывает в каждом PR, который трогает файл, и у каждой модели. Строка сдвигается от коммита
// к коммиту, а заголовок модель каждый раз пишет по-своему, поэтому совпадением считается любое из двух
const findSame = (items, entry) =>
    items.find(
        (item) =>
            item.repo === entry.repo &&
            item.path === entry.path &&
            (normalize(item.title) === normalize(entry.title) || (item.line && entry.line && Math.abs(item.line - entry.line) <= 2)),
    );

// Возвращает запись и признак, новая ли она
export const addToBacklog = (entry, source) => {
    const items = loadBacklog();
    const at = new Date().toISOString();
    const same = findSame(items, entry);
    if (same) {
        if (!same.sources.some((known) => known.pr === source.pr && known.agent === source.agent)) same.sources.push({ ...source, at });
        if (LEVELS.indexOf(entry.level) < LEVELS.indexOf(same.level)) same.level = entry.level;
        same.updatedAt = at;
        saveBacklog(items);
        return { item: same, added: false };
    }
    const item = { id: randomBytes(3).toString('hex'), status: 'open', ...entry, createdAt: at, updatedAt: at, sources: [{ ...source, at }] };
    saveBacklog([...items, item]);
    return { item, added: true };
};

export const setBacklogStatus = (id, status, text = '') => {
    if (!STATUSES[status]) throw new Error(`Статус: ${Object.keys(STATUSES).join(' | ')}`);
    const items = loadBacklog();
    const item = items.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`В бэклоге нет ${id}`);
    item.status = status;
    item.updatedAt = new Date().toISOString();
    if (status === 'filed') item.ticket = text || null;
    if (status === 'dropped') item.note = text || null;
    // Вернули в ожидание — прежний номер задачи и причина отклонения больше не про эту запись
    if (status === 'open') {
        item.ticket = null;
        item.note = null;
    }
    saveBacklog(items);
    return item;
};

// Итог разбора по коду: актуальна ли проблема на текущем коде основной ветки. Закрывает запись человек, разбор только подсказывает.
// Если проблема на месте, но код сдвинулся, запоминаем новое место — по нему склеиваются повторы и открывается файл
export const setBacklogTriage = (id, triage, location = null) => {
    const items = loadBacklog();
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return null;
    item.triage = triage;
    if (location?.path) {
        item.path = location.path;
        item.line = location.line || null;
    }
    saveBacklog(items);
    return item;
};

const byPriority = (a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || b.sources.length - a.sources.length;

// Список для модели: чтобы она не возвращала то, что уже известно, — в том числе отклонённое на разборе
export const renderBacklogForPrompt = (slug) =>
    loadBacklog()
        .filter((item) => item.repo === slug)
        .sort(byPriority)
        .slice(0, 100)
        .map((item) => `- \`${item.path}${item.line ? `:${item.line}` : ''}\` — ${item.title}`)
        .join('\n');

const prLinks = (item) => item.sources.map((source) => `[#${source.pr}](${source.url})`).filter((link, index, all) => all.indexOf(link) === index);

// Markdown для еженедельного разбора: по репозиториям, самые важные и часто встречающиеся сверху
export const renderBacklog = (items) => {
    if (!items.length) return 'Бэклог пуст.\n';
    return [...Map.groupBy(items, (item) => item.repo)]
        .map(([repo, group]) => {
            const entries = group.sort(byPriority).map((item) => {
                const meta = [
                    `${item.path}${item.line ? `:${item.line}` : ''}`,
                    `найдено в ${prLinks(item).join(', ')}`,
                    item.status !== 'open' ? STATUSES[item.status] + (item.ticket ? ` (${item.ticket})` : '') : null,
                ].filter(Boolean);
                return [`### [${item.level}] ${item.title} · \`${item.id}\``, meta.join(' · '), item.scenario, item.fix, item.note ? `Примечание: ${item.note}` : null]
                    .filter(Boolean)
                    .join('\n\n');
            });
            return [`## ${repo}`, ...entries].join('\n\n');
        })
        .join('\n\n---\n\n');
};
