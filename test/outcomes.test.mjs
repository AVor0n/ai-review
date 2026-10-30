import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

// Данные сервиса лежат в HOME: подменяем его до импорта, чтобы исходы писались во временную папку
const home = mkdtempSync(join(tmpdir(), 'pr-reviewer-test-'));
process.env.HOME = home;
const dataDir = join(home, 'Library/Application Support/pr-reviewer');
const { markResolved, recordClosed, trackOutcomes } = await import('../src/outcomes.mjs');

const load = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
const comments = load('comments.json');
const agents = load('agents.json');
const ctx = { dryRun: false };
const repo = { slug: 'demo' };
const outcomes = () => readFileSync(join(dataDir, 'outcomes.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const finding = (fields) => ({ agent: 'claude', role: 'first', level: 'P1', path: 'app.txt', at: '2026-10-28T10:00:00Z', ...fields });

beforeEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
});
after(() => rmSync(home, { recursive: true, force: true }));

test('ответ человека в треде — спор, Resolve — закрытый тред', () => {
    const prState = { findings: [finding({ commentId: 101 }), finding({ commentId: 201 }), finding({ commentId: 301 })] };
    markResolved(prState, comments, agents);
    assert.deepEqual(prState.findings.map(({ commentId, resolved, disputed }) => [commentId, resolved, disputed]), [
        [101, false, true],
        [201, true, false],
        [301, false, false],
    ]);
});

test('закрытие своего треда моделью: исправлено, отложено или отклонено', () => {
    const prState = { findings: [finding({ commentId: 1 }), finding({ commentId: 2 }), finding({ commentId: 3 })] };
    recordClosed(ctx, repo, 7, prState, 1, 'fixed');
    recordClosed(ctx, repo, 7, prState, 2, 'deferred');
    recordClosed(ctx, repo, 7, prState, 3, 'wontfix');
    recordClosed(ctx, repo, 7, prState, 404, 'fixed');
    assert.deepEqual(outcomes().map(({ commentId, outcome, disputed }) => [commentId, outcome, disputed]), [
        [1, 'addressed', undefined],
        [2, 'deferred', true],
        [3, 'dismissed', true],
    ]);
    assert.deepEqual(prState.findings, []);
});

// Репозиторий из двух коммитов: во втором правится 10-я строка app.txt
const makeRepo = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-reviewer-repo-'));
    const git = (...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q');
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    writeFileSync(join(dir, 'app.txt'), `${lines.join('\n')}\n`);
    git('add', '.');
    git('commit', '-qm', 'first');
    const first = git('rev-parse', 'HEAD');
    lines[9] = 'line 10 changed';
    writeFileSync(join(dir, 'app.txt'), `${lines.join('\n')}\n`);
    git('commit', '-qam', 'second');
    return { dir, first, second: git('rev-parse', 'HEAD') };
};

test('новая голова: правка рядом со строкой замечания засчитывается как исправление', () => {
    const { dir, first, second } = makeRepo();
    const prState = {
        findings: [
            finding({ commentId: 11, line: 12, commit: first }),
            finding({ commentId: 12, line: 18, commit: first }),
            finding({ commentId: 13, line: 10, commit: second }),
        ],
    };
    trackOutcomes(ctx, repo, 7, prState, dir, second);
    assert.deepEqual(outcomes().map(({ commentId, outcome }) => [commentId, outcome]), [[11, 'addressed']]);
    assert.deepEqual(prState.findings.map(({ commentId }) => commentId), [12, 13]);
    rmSync(dir, { recursive: true, force: true });
});

test('доработка, которая отчиталась об исправлении, засчитывается, даже если правка далеко от строки', () => {
    const { dir, first, second } = makeRepo();
    writeFileSync(join(dataDir, 'fixes.jsonl'), `${JSON.stringify({ repo: 'demo', pr: 7, status: 'pushed', head: second, fixedIds: [12] })}\n`);
    const prState = { findings: [finding({ commentId: 12, line: 18, commit: first })] };
    trackOutcomes(ctx, repo, 7, prState, dir, second);
    assert.deepEqual(outcomes().map(({ commentId, outcome }) => [commentId, outcome]), [[12, 'addressed']]);
    rmSync(dir, { recursive: true, force: true });
});
