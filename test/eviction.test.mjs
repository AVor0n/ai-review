import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Журналы статистики лежат в HOME: подменяем его до импорта store.mjs
const home = mkdtempSync(join(tmpdir(), 'pr-reviewer-test-'));
process.env.HOME = home;
const { DATA_DIR } = await import('../src/store.mjs');
const { EVICTION_WINDOW, countLessonUsage, pickEvictions } = await import('../src/lesson-usage.mjs');
after(() => rmSync(home, { recursive: true, force: true }));

const RUNS = 120;
const runAt = (index) => new Date(Date.UTC(2026, 9, 1) + index * 3600_000).toISOString();
const runTimes = Array.from({ length: RUNS }, (_, index) => runAt(index));
const OLD = '2026-09-01T00:00:00.000Z';

const lesson = (id, extra = {}) => ({ id, text: `правило ${id}`, at: OLD, ...extra });
const counts = (applied, last, addressed = 0, dismissed = 0) => ({ applied, findings: addressed + dismissed, addressed, dismissed, last });
const pick = (lessons, overflow, usage) => pickEvictions(lessons, overflow, { usage: new Map(Object.entries(usage)), runs: RUNS, runTimes });
const ids = (result) => result.victims.map(({ lesson }) => lesson.id);

test('порядок: отклоняемые, затем неприменявшиеся за окно, затем реже всех применяемые', () => {
    const lessons = [lesson('frequent'), lesson('rare'), lesson('idle'), lesson('rejected'), lesson('never')];
    const usage = {
        frequent: counts(60, RUNS - 1),
        rare: counts(5, RUNS - 3),
        idle: counts(9, RUNS - 1 - EVICTION_WINDOW),
        rejected: counts(40, RUNS - 1, 1, 3),
    };
    assert.deepEqual(ids(pick(lessons, 4, usage)), ['rejected', 'never', 'idle', 'rare']);
    const reasons = Object.fromEntries(pick(lessons, 4, usage).victims.map(({ lesson, reason }) => [lesson.id, reason]));
    assert.equal(reasons.rejected, 'замечания по правилу отклонили 3 раза, исправили 1 раз');
    assert.equal(reasons.idle, `не применялось за последние ${EVICTION_WINDOW} запусков (всего применялось 9 раз)`);
    assert.equal(reasons.never, `не применялось за последние ${EVICTION_WINDOW} запусков`);
    assert.equal(reasons.rare, `применялось реже остальных: 5 раз за ${RUNS} запусков`);
});

test('самое полезное правило не вытесняется, даже если оно самое старое', () => {
    const lessons = [lesson('copyright', { at: '2026-01-01T00:00:00.000Z' }), lesson('newer')];
    assert.deepEqual(ids(pick(lessons, 1, { copyright: counts(83, RUNS - 1, 4, 0), newer: counts(2, RUNS - 2) })), ['newer']);
});

test('запрещающее правило без замечаний, но с применениями, остаётся; поровну отклонённых и исправленных — не повод', () => {
    const lessons = [lesson('forbid'), lesson('balanced')];
    const usage = { forbid: counts(30, RUNS - 1), balanced: counts(10, RUNS - 1, 2, 2) };
    const result = pick(lessons, 1, usage);
    assert.deepEqual(ids(result), ['balanced']);
    assert.match(result.victims[0].reason, /^применялось реже остальных/);
});

test('при равной доле применений вытесняется старшее', () => {
    const lessons = [lesson('young', { at: '2026-09-20T00:00:00.000Z' }), lesson('elder', { at: '2026-09-10T00:00:00.000Z' })];
    assert.deepEqual(ids(pick(lessons, 1, { young: counts(12, RUNS - 1), elder: counts(12, RUNS - 1) })), ['elder']);
});

test('ручные, исправленные и младше окна не вытесняются; без кандидатов лимит превышается', () => {
    const lessons = [lesson('manual', { manual: true }), lesson('edited', { edited: true }), lesson('fresh', { at: runAt(RUNS - EVICTION_WINDOW + 1) }), lesson('grown', { at: runAt(RUNS - EVICTION_WINDOW) })];
    const result = pick(lessons, 2, {});
    assert.deepEqual(ids(result), ['grown']);
    assert.equal(result.short, 1);
    assert.deepEqual(pick(lessons.slice(0, 3), 1, {}), { victims: [], short: 1 });
    assert.deepEqual(pick(lessons, 0, {}), { victims: [], short: 0 });
});

test('счёт применений: по appliedLessons своего репозитория, склеенное правило наследует исходные', () => {
    mkdirSync(DATA_DIR, { recursive: true });
    const stats = [
        { repo: 'backend', at: runAt(0), appliedLessons: ['old1', 'keep'] },
        { repo: 'frontend', at: runAt(1), appliedLessons: ['keep'] },
        { repo: 'backend', at: runAt(2) },
        { repo: 'backend', at: runAt(3), appliedLessons: ['old2', 'old1'] },
        { repo: 'backend', at: runAt(4), appliedLessons: [] },
    ];
    const outcomes = [
        { repo: 'backend', lessons: ['old1'], outcome: 'dismissed' },
        { repo: 'backend', lessons: ['keep'], outcome: 'unchanged' },
        { repo: 'backend', lessons: ['keep'], outcome: 'addressed' },
    ];
    writeFileSync(join(DATA_DIR, 'stats.jsonl'), stats.map((entry) => JSON.stringify(entry)).join('\n'));
    writeFileSync(join(DATA_DIR, 'outcomes.jsonl'), outcomes.map((entry) => JSON.stringify(entry)).join('\n'));
    const lessons = [lesson('merged', { source: { mergedFrom: ['old1', 'old2'] } }), lesson('keep')];
    const { usage, runs, runTimes: times } = countLessonUsage('backend', lessons);
    assert.equal(runs, 3);
    assert.deepEqual(times, [runAt(0), runAt(3), runAt(4)]);
    assert.deepEqual(usage.get('merged'), { applied: 2, findings: 1, addressed: 0, dismissed: 1, last: 1 });
    assert.deepEqual(usage.get('keep'), { applied: 1, findings: 2, addressed: 1, dismissed: 1, last: 0 });
});
