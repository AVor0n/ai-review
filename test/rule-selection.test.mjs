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
const { graphPicks, historyBefore } = await import('../src/rule-binding.mjs');
const { selectionReport, renderSelectionReport } = await import('../src/rule-selection-report.mjs');
const { loadGraph } = await import('../src/rule-graph.mjs');
after(() => rmSync(home, { recursive: true, force: true }));

// Сообщества: native — 1 auth, 2 csv, 3 plot, 4 seed; nolibs — 10 (auth+csv), 11, 12
const files = {
    'auth/Filter.java': { native: 1, nolibs: 10 },
    'auth/Config.java': { native: 1, nolibs: 11 },
    'csv/Import.java': { native: 2, nolibs: 10 },
    'plot/Plot.java': { native: 3, nolibs: 12 },
    'seed/Seed.java': { native: 4, nolibs: 12 },
};
const empty = { runs: [], findings: [], filesOfPr: () => [] };
const pick = (options) => graphPicks({ lessonIds: ['thread', 'finding', 'frequent', 'broad', 'other'], tIds: [], lessonFiles: { thread: ['auth/Filter.java'] }, variants: ['native', 'nolibs'], files, history: empty, currentPr: 99, ...options });

test('G: файл треда-источника и файлы замечаний по правилу; G′ — по сообществам без библиотек', () => {
    const history = { ...empty, findings: [{ pr: 5, path: 'csv/Import.java', lessons: ['finding'] }] };
    const { picks, communities } = pick({ prPaths: ['auth/Config.java', 'new/File.java'], history });
    assert.deepEqual(communities, { native: [1], nolibs: [11] });
    assert.deepEqual(picks.G, ['thread']);
    assert.deepEqual(picks.G2, []);
    // Файл замечания в csv (native 2) и файл треда в auth (native 1) — в G′ это одно сообщество 10
    assert.deepEqual(pick({ prPaths: ['csv/Import.java'], history }).picks.G2.sort(), ['finding', 'thread']);
});

test('G: применения дают сообщество только при lift ≥ 2 и хотя бы двух PR, а не все файлы PR', () => {
    const prFiles = { 1: ['plot/Plot.java', 'auth/Filter.java'], 2: ['plot/Plot.java'], 3: ['seed/Seed.java'], 4: ['seed/Seed.java'], 5: ['auth/Config.java'], 6: ['csv/Import.java'] };
    // frequent применялось в 1 и 2: оба трогали plot (доля в plot 2/2 против общей 2/6 — lift 3); broad — везде
    const runs = [1, 2, 3, 4, 5, 6].map((pr) => ({ pr, appliedLessons: ['broad', ...(pr <= 2 ? ['frequent'] : [])] }));
    const history = { runs, findings: [], filesOfPr: (pr) => prFiles[pr] ?? [] };
    assert.deepEqual(pick({ prPaths: ['plot/Plot.java'], history }).picks.G, ['frequent']);
    // auth трогал PR 1 с frequent, но это один PR — порога в два PR нет
    assert.deepEqual(pick({ prPaths: ['auth/Config.java'], history }).picks.G, ['thread']);
    // Без утечки: применения и замечания самого PR в привязку не идут
    assert.deepEqual(pick({ prPaths: ['plot/Plot.java'], history, currentPr: 2 }).picks.G, []);
});

test('ранг: больше свидетельств в сообществах PR — выше; TG — сначала оба, потом только T, потом только граф', () => {
    const history = { ...empty, findings: [{ pr: 5, path: 'auth/Config.java', lessons: ['finding'] }, { pr: 6, path: 'auth/Filter.java', lessons: ['finding'] }] };
    const { picks } = pick({ prPaths: ['auth/Filter.java'], history, tIds: ['thread', 'other'] });
    assert.deepEqual(picks.G, ['finding', 'thread']);
    assert.deepEqual(picks.TG, ['thread', 'other', 'finding']);
});

test('selectRules: T по тегам и «общим»; без графа стратегий по графу нет; только native, если G′ не включён', () => {
    const lessons = ['general', 'migration', 'thread'].map((id) => ({ id, text: `правило ${id}`, at: '2026-11-01T00:00:00.000Z' }));
    const data = { graph: ['native'], lessonTags: { general: [GENERAL], migration: ['новая миграция'] }, lessonFiles: { thread: ['auth/Filter.java'] } };
    const noGraph = selectRules({ lessons, data, prTags: ['новая миграция'], prPaths: [], graph: null, history: empty, currentPr: 1 });
    assert.deepEqual(Object.keys(noGraph.picks), ['T']);
    assert.deepEqual(noGraph.picks.T.ids, ['general', 'migration']);
    assert.equal(noGraph.picks.T.chars, lessonChars(lessons[0]) + lessonChars(lessons[1]));
    const withGraph = selectRules({ lessons, data, prTags: [], prPaths: ['auth/Config.java'], graph: { files }, history: empty, currentPr: 1 });
    assert.deepEqual(Object.keys(withGraph.picks).sort(), ['G', 'T', 'TG']);
    assert.deepEqual(withGraph.picks.TG.ids, ['general', 'thread']);
    assert.equal(withGraph.picks.G.chars, lessonChars(lessons[2]));
});

test('historyBefore: только запуски и исходы раньше момента, файлы PR — по отревьюенным головам', () => {
    const stats = [
        { repo: 'backend', pr: 1, head: 'a', at: '2026-11-17T09:00:00Z', appliedLessons: ['x'] },
        { repo: 'backend', pr: 1, head: 'b', at: '2026-11-17T11:00:00Z', appliedLessons: ['y'] },
        { repo: 'frontend', pr: 1, head: 'a', at: '2026-11-17T09:00:00Z', appliedLessons: ['z'] },
    ];
    const outcomes = [
        { repo: 'backend', pr: 1, path: 'p.java', lessons: ['x'], at: '2026-11-17T09:30:00Z' },
        { repo: 'backend', pr: 1, path: 'q.java', lessons: ['y'], at: '2026-11-17T12:00:00Z' },
    ];
    const history = historyBefore({ stats, outcomes, prFiles: { '1@a': ['one'], '1@b': ['two'] }, repo: 'backend', before: '2026-11-17T10:00:00Z' });
    assert.deepEqual(history.runs, [{ pr: 1, appliedLessons: ['x'] }]);
    assert.deepEqual(history.findings, [{ pr: 1, path: 'p.java', lessons: ['x'] }]);
    assert.deepEqual(history.filesOfPr(1), ['one']);
});

test('без установленного Graphify граф не строится', async () => {
    assert.equal(await loadGraph({ slug: 'backend' }, home, 'origin/develop', ['native']), null);
});

const write = (path, entries) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n'));
};

test('отчёт: полнота, при размере T, строгая полнота, точность, размер и потери', () => {
    const row = (pr, head, at, picks) => ({ at, repo: 'backend', pr, head, tags: [], communities: {}, graphCommit: null, total: { ids: ['a', 'b', 'c', 'd'], chars: 400 }, picks });
    write(JOURNAL_FILE, [
        row(1, 'h1', '2026-11-17T10:00:00.000Z', { T: { ids: ['a', 'b'], chars: 200 }, G: { ids: ['d', 'c'], chars: 200 } }),
        row(2, 'h2', '2026-11-17T12:00:00.000Z', { T: { ids: ['a'], chars: 100 }, G: { ids: ['a', 'd'], chars: 200 } }),
        { ...row(9, 'h9', '2026-11-17T12:00:00.000Z', { T: { ids: [], chars: 0 } }), repo: 'frontend' },
    ]);
    write(join(DATA_DIR, 'stats.jsonl'), [
        { repo: 'backend', pr: 1, head: 'h1', at: '2026-11-17T10:05:00.000Z', appliedLessons: ['a', 'c'] },
        { repo: 'backend', pr: 1, head: 'h1', at: '2026-11-17T10:09:00.000Z', appliedLessons: ['b'] },
        { repo: 'backend', pr: 1, head: 'h0', at: '2026-11-17T09:00:00.000Z', appliedLessons: ['d'] },
        { repo: 'backend', pr: 2, head: 'h2', at: '2026-11-17T12:05:00.000Z', appliedLessons: ['d'] },
    ]);
    // Замечание по правилу c в PR 1 опубликовано около 10:06, разрешено через 3 часа
    write(join(DATA_DIR, 'outcomes.jsonl'), [{ repo: 'backend', pr: 1, at: '2026-11-17T13:06:00.000Z', hours: 3, path: 'x.java', lessons: ['c'], outcome: 'addressed' }]);

    const [backend] = selectionReport({ repo: 'backend' }).repos;
    assert.equal(backend.heads, 2);
    assert.equal(backend.runs, 3);
    assert.deepEqual(backend.totals.all, { heads: 2, hits: 4, reference: 4, picked: 12, equalHits: 0, strictHits: 1, strictReference: 1, count: 8, chars: 800 });
    assert.deepEqual(backend.totals.T, { heads: 2, hits: 2, reference: 4, picked: 5, equalHits: 2, strictHits: 0, strictReference: 1, count: 3, chars: 300 });
    // G при размере T: в PR 1 из [d, c] остаются оба, в PR 2 из [a, d] — только a
    assert.deepEqual(backend.totals.G, { heads: 2, hits: 2, reference: 4, picked: 6, equalHits: 1, strictHits: 1, strictReference: 1, count: 4, chars: 400 });
    assert.deepEqual(backend.misses, [{ pr: 1, head: 'h1', strategy: 'T', id: 'c' }]);
    const text = renderSelectionReport(selectionReport({ repo: 'backend' }));
    assert.match(text, /\| T \| 50% \(2\/4\) \| 50% \| 0% \(0\/1\) \| 40% \| 2 \| 150 \|/);
    assert.match(text, /\| G \| 50% \(2\/4\) \| 25% \|/);
    assert.match(text, /PR #1 \(h1\) · T · \[c\]/);
    assert.equal(selectionReport({ since: '2026-11-18' }).repos.length, 0);
});

test('отчёт пересчитывает G по снимку графа и новой привязке, а не берёт записанный подбор', () => {
    write(join(DATA_DIR, 'memory', 'backend.selection.json'), []);
    writeFileSync(join(DATA_DIR, 'memory', 'backend.selection.json'), JSON.stringify({ graph: ['native'], vocabulary: [], lessonTags: {}, lessonFiles: { b: ['auth/Filter.java'] }, prFiles: {} }));
    write(join(home, '.pr-reviewer/graphs/backend/snapshots/abc123abc123.json'), []);
    writeFileSync(join(home, '.pr-reviewer/graphs/backend/snapshots/abc123abc123.json'), JSON.stringify({ commit: 'abc123abc123ff', files }));
    // Записан широкий подбор старой привязки; по новой правило b (тред в auth) — единственное для PR в auth
    write(JOURNAL_FILE, [
        {
            at: '2026-11-17T10:00:00.000Z', repo: 'backend', pr: 1, head: 'h1', tags: [], files: ['auth/Config.java'], communities: { native: [1] }, graphCommit: 'abc123abc123ff',
            sizes: { a: 100, b: 70, c: 100 }, total: { ids: ['a', 'b', 'c'], chars: 270 }, picks: { T: { ids: ['a'], chars: 100 }, G: { ids: ['a', 'b', 'c'], chars: 270 }, TG: { ids: ['a', 'b', 'c'], chars: 270 } },
        },
    ]);
    const [backend] = selectionReport({ repo: 'backend' }).repos;
    assert.equal(backend.totals.G.count, 1);
    assert.equal(backend.totals.G.chars, 70);
    assert.equal(backend.totals.TG.count, 2);
});
