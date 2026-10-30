import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { authorOf, buildThreads, ownThreadsToCheck, pendingRoots } from '../src/comments.mjs';

const load = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
const comments = load('comments.json');
const agents = load('agents.json');
const ids = (items) => items.map((item) => (item.root ?? item).id);

test('автор определяется по подписи модели, остальное — человек', () => {
    assert.deepEqual(comments.slice(0, 5).map((comment) => authorOf(comment, agents)), ['claude', 'human', 'codex', 'codex', 'human']);
});

test('ответы собираются под корнем треда, даже ответ на ответ', () => {
    const threads = buildThreads(comments);
    assert.deepEqual(ids(threads), [101, 201, 301, 401, 501]);
    assert.deepEqual(threads[0].replies.map((reply) => reply.id), [102, 103]);
});

test('ответ на тред, которого нет в выдаче, не создаёт нового треда', () => {
    assert.ok(!buildThreads(comments).some(({ replies }) => replies.some((reply) => reply.id === 502)));
});

test('модель отвечает в чужих тредах, где ещё не высказалась; черновики и удалённые пропускаются', () => {
    assert.deepEqual(ids(pendingRoots(comments, 'claude', [], agents)), [201, 301]);
    assert.deepEqual(ids(pendingRoots(comments, 'claude', [301], agents)), [201]);
    assert.deepEqual(ids(pendingRoots(comments, 'codex', [], agents)), [301]);
});

test('свой тред перепроверяется на новой голове или после нового ответа человека', () => {
    const own = ownThreadsToCheck(comments, 'claude', agents, 'head-1');
    assert.deepEqual(own.map(({ root, lastHumanReply }) => [root.id, lastHumanReply]), [[101, 102]]);
    assert.deepEqual(ownThreadsToCheck(comments, 'claude', agents, 'head-1', { 101: { head: 'head-1', lastHumanReply: 102 } }), []);
    assert.deepEqual(ids(ownThreadsToCheck(comments, 'claude', agents, 'head-2', { 101: { head: 'head-1', lastHumanReply: 102 } })), [101]);
    assert.deepEqual(ids(ownThreadsToCheck(comments, 'claude', agents, 'head-1', { 101: { head: 'head-1', lastHumanReply: 50 } })), [101]);
});

test('закрытый через Resolve тред больше не проверяется', () => {
    assert.deepEqual(ownThreadsToCheck(comments, 'codex', agents, 'head-1'), []);
});
