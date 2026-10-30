import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { runPool } from '../src/pool.mjs';

// status.json лежит в HOME: подменяем его до импорта store.mjs
const home = mkdtempSync(join(tmpdir(), 'pr-reviewer-test-'));
process.env.HOME = home;
const { loadStatus, setRunning } = await import('../src/store.mjs');
after(() => rmSync(home, { recursive: true, force: true }));

test('одновременно идёт не больше заданного числа дорожек, и проходят все', async () => {
    let active = 0;
    let peak = 0;
    const done = [];
    await runPool(['a', 'b', 'c', 'd', 'e'], 2, async (item) => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(item === 'a' ? 30 : 5);
        done.push(item);
        active -= 1;
    });
    assert.equal(peak, 2);
    assert.deepEqual([...done].sort(), ['a', 'b', 'c', 'd', 'e']);
    assert.notEqual(done[0], 'a');
});

test('одна дорожка — строго по очереди, как раньше', async () => {
    const done = [];
    await runPool([1, 2, 3], 1, async (item) => {
        await sleep(4 - item);
        done.push(item);
    });
    assert.deepEqual(done, [1, 2, 3]);
});

test('текущие ревью: по одному на репозиторий, по времени начала, current — самое раннее', () => {
    setRunning('backend', { repo: 'backend', pr: 2, agent: 'codex', startedAt: '2026-10-30T10:05:00Z' });
    setRunning('frontend', { repo: 'frontend', pr: 1, agent: 'claude', startedAt: '2026-10-30T10:00:00Z' });
    setRunning('backend', { repo: 'backend', pr: 2, agent: 'cursor', startedAt: '2026-10-30T10:07:00Z' });
    let status = loadStatus();
    assert.deepEqual(status.running.map(({ repo, agent }) => [repo, agent]), [['frontend', 'claude'], ['backend', 'cursor']]);
    assert.equal(status.current.repo, 'frontend');
    setRunning('frontend', null);
    status = loadStatus();
    assert.deepEqual(status.running.map(({ repo }) => repo), ['backend']);
    assert.equal(status.current.repo, 'backend');
    setRunning('backend', null);
    assert.equal(loadStatus().current, null);
});
