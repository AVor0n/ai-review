import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Журналы и граф лежат в HOME: подменяем его до импорта store.mjs
const home = mkdtempSync(join(tmpdir(), 'pr-reviewer-test-'));
process.env.HOME = home;
const { DATA_DIR } = await import('../src/store.mjs');
const { GENERAL, JOURNAL_FILE, lessonChars, selectRules } = await import('../src/rule-selection.mjs');
const { selectionReport, renderSelectionReport } = await import('../src/rule-selection-report.mjs');
const { loadGraph } = await import('../src/rule-graph.mjs');
after(() => rmSync(home, { recursive: true, force: true }));

const lesson = (id) => ({ id, text: `правило ${id}`, at: '2026-11-01T00:00:00.000Z' });
const lessons = ['general', 'migration', 'query', 'thread', 'applied', 'lonely'].map(lesson);
const data = {
    graph: ['native', 'nolibs'],
    lessonTags: { general: [GENERAL], migration: ['новая миграция'], query: ['mybatis-запрос'], thread: ['права доступа'], applied: ['импорт csv'] },
    lessonFiles: { thread: ['src/auth/Filter.java'] },
};
const graph = {
    files: {
        'src/auth/Filter.java': { native: 1, nolibs: 10 },
        'src/auth/Config.java': { native: 1, nolibs: 11 },
        'src/csv/Import.java': { native: 2, nolibs: 10 },
        'src/plot/Plot.java': { native: 3, nolibs: 12 },
    },
};
const ids = (choice) => choice.ids.sort();

test('T — правила с тегами PR и «общие»; без графа стратегии G не считаются', () => {
    const { picks, prCommunities } = selectRules({ lessons, data, prTags: ['новая миграция'], prPaths: [], graph: null, applications: [], filesOf: () => [] });
    assert.deepEqual(Object.keys(picks), ['T']);
    assert.deepEqual(ids(picks.T), ['general', 'migration']);
    assert.equal(picks.T.chars, lessonChars(lessons[0]) + lessonChars(lessons[1]));
    assert.deepEqual(prCommunities, {});
});

test('G — по файлу треда и по файлам PR, где правило применялось; G′ — по сообществам без библиотек; TG — объединение', () => {
    const applications = [{ pr: 7, head: 'aaa', appliedLessons: ['applied', 'unknown'] }];
    const filesOf = (key) => (key === '7@aaa' ? ['src/csv/Import.java'] : []);
    const { picks, prCommunities } = selectRules({ lessons, data, prTags: ['mybatis-запрос'], prPaths: ['src/auth/Config.java', 'src/new/File.java'], graph, applications, filesOf });
    assert.deepEqual(prCommunities, { native: [1], nolibs: [11] });
    assert.deepEqual(ids(picks.G), ['thread']);
    assert.deepEqual(ids(picks.G2), []);
    assert.deepEqual(ids(picks.TG), ['general', 'query', 'thread']);
    assert.deepEqual(ids(picks.TG2), ['general', 'query']);

    const csv = selectRules({ lessons, data, prTags: [], prPaths: ['src/auth/Filter.java'], graph, applications, filesOf }).picks;
    // В G′ файл треда (10) и файл применения (10) в одном сообществе с PR
    assert.deepEqual(ids(csv.G2), ['applied', 'thread']);
    assert.deepEqual(ids(csv.G), ['thread']);
});

test('только родные сообщества, если G′ для репозитория не включён', () => {
    const { picks } = selectRules({ lessons, data: { ...data, graph: ['native'] }, prTags: [], prPaths: ['src/auth/Filter.java'], graph, applications: [], filesOf: () => [] });
    assert.deepEqual(Object.keys(picks).sort(), ['G', 'T', 'TG']);
});

test('без установленного Graphify граф не строится', async () => {
    assert.equal(await loadGraph({ slug: 'backend' }, home, 'origin/develop', ['native']), null);
});

test('отчёт: полнота по appliedLessons, строгая полнота по замечаниям, точность, размер и потери', () => {
    mkdirSync(DATA_DIR, { recursive: true });
    const row = (pr, head, at, picks) => ({ at, repo: 'backend', pr, head, tags: [], communities: {}, total: { ids: ['a', 'b', 'c', 'd'], chars: 400 }, picks });
    const journal = [
        row(1, 'h1', '2026-11-17T10:00:00.000Z', { T: { ids: ['a', 'b'], chars: 200 }, G: { ids: ['c'], chars: 100 } }),
        row(2, 'h2', '2026-11-17T12:00:00.000Z', { T: { ids: ['a'], chars: 100 }, G: { ids: ['a', 'd'], chars: 200 } }),
        { ...row(9, 'h9', '2026-11-17T12:00:00.000Z', {}), repo: 'frontend' },
    ];
    writeFileSync(JOURNAL_FILE, journal.map((entry) => JSON.stringify(entry)).join('\n'));
    const stats = [
        { repo: 'backend', pr: 1, head: 'h1', at: '2026-11-17T10:05:00.000Z', appliedLessons: ['a', 'c'] },
        { repo: 'backend', pr: 1, head: 'h1', at: '2026-11-17T10:09:00.000Z', appliedLessons: ['b'] },
        { repo: 'backend', pr: 1, head: 'h0', at: '2026-11-17T09:00:00.000Z', appliedLessons: ['d'] },
        { repo: 'backend', pr: 2, head: 'h2', at: '2026-11-17T12:05:00.000Z', appliedLessons: ['d'] },
    ];
    writeFileSync(join(DATA_DIR, 'stats.jsonl'), stats.map((entry) => JSON.stringify(entry)).join('\n'));
    // Замечание по правилу c в PR 1 опубликовано около 10:06, разрешено через 3 часа
    const outcomes = [{ repo: 'backend', pr: 1, at: '2026-11-17T13:06:00.000Z', hours: 3, lessons: ['c'], outcome: 'addressed' }];
    writeFileSync(join(DATA_DIR, 'outcomes.jsonl'), outcomes.map((entry) => JSON.stringify(entry)).join('\n'));

    const [backend] = selectionReport({ repo: 'backend' }).repos;
    assert.equal(backend.heads, 2);
    assert.equal(backend.runs, 3);
    assert.deepEqual(backend.totals.all, { heads: 2, hits: 4, reference: 4, picked: 12, strictHits: 1, strictReference: 1, count: 8, chars: 800 });
    assert.deepEqual(backend.totals.T, { heads: 2, hits: 2, reference: 4, picked: 5, strictHits: 0, strictReference: 1, count: 3, chars: 300 });
    assert.deepEqual(backend.totals.G, { heads: 2, hits: 2, reference: 4, picked: 4, strictHits: 1, strictReference: 1, count: 3, chars: 300 });
    assert.deepEqual(backend.misses, [{ pr: 1, head: 'h1', strategy: 'T', id: 'c' }]);
    const text = renderSelectionReport(selectionReport({ repo: 'backend' }));
    assert.match(text, /\| T \| 50% \(2\/4\) \| 0% \(0\/1\) \| 40% \| 2 \| 150 \|/);
    assert.match(text, /PR #1 \(h1\) · T · \[c\]/);
    assert.equal(selectionReport({ since: '2026-11-18' }).repos.length, 0);
});
