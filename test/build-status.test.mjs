import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Журнал сервиса лежит в HOME: подменяем его до импорта store.mjs
const home = mkdtempSync(join(tmpdir(), 'pr-reviewer-test-'));
process.env.HOME = home;
const { STATUS_KEY, buildStatusEnabled, postBuildStatus, skipText, summaryText } = await import('../src/build-status.mjs');
after(() => rmSync(home, { recursive: true, force: true }));

const agents = { claude: { shortName: 'Claude' }, codex: { shortName: 'Codex' }, cursor: { shortName: 'Cursor' } };
const repo = { workspace: 'team', slug: 'backend' };
const pr = { id: 7, links: { html: { href: 'https://bitbucket.org/team/backend/pull-requests/7' } } };
const none = { P0: 0, P1: 0, P2: 0, P3: 0 };

test('флаг: по умолчанию выключен; список prs ограничивает статус своими PR', () => {
    assert.equal(buildStatusEnabled({}, repo, pr), false);
    assert.equal(buildStatusEnabled({ buildStatus: { enabled: false } }, repo, pr), false);
    assert.equal(buildStatusEnabled({ buildStatus: { enabled: true } }, repo, pr), true);
    assert.equal(buildStatusEnabled({ buildStatus: { enabled: true, prs: ['backend#7'] } }, repo, pr), true);
    assert.equal(buildStatusEnabled({ buildStatus: { enabled: true, prs: ['backend#8', 'frontend#7'] } }, repo, pr), false);
});

test('итог: число моделей и замечания по уровням, «замечаний нет», неудачные запуски', () => {
    const clean = { agents: { claude: none, codex: none, cursor: none } };
    assert.equal(summaryText(clean, agents), '3 модели (Claude, Codex, Cursor): замечаний нет');
    const found = { agents: { claude: { ...none, P1: 2 }, codex: { ...none, P1: 1, P3: 1 } } };
    assert.equal(summaryText(found, agents), '2 модели (Claude, Codex): замечания P1: 3, P3: 1');
    assert.equal(summaryText({ agents: { claude: none } }, agents, ['codex']), '1 модель (Claude): замечаний нет · не удалось: Codex');
    assert.equal(summaryText({ agents: {} }, agents, ['claude', 'codex']), 'Ревью не удалось (Claude, Codex), повторим на следующем проходе');
});

test('исчерпанный лимит — отдельно от «не удалось», с датой сброса', () => {
    const until = new Date(2026, 10, 25, 12);
    assert.equal(summaryText({ agents: { claude: none } }, agents, ['cursor', 'codex'], { cursor: until }), '1 модель (Claude): замечаний нет · не удалось: Codex · Cursor — лимит до 25.11');
    assert.equal(summaryText({ agents: {} }, agents, ['cursor'], { cursor: until }), 'Ревью не было: Cursor — лимит до 25.11');
});

test('ревью не нужно: причина словами, после rebase — с итогом прошлого ревью', () => {
    assert.equal(skipText('empty', null, agents), 'Ревью не нужно: в PR нет изменений относительно целевой ветки');
    assert.equal(skipText('ignored', null, agents), 'Ревью не нужно: в диффе только исключённые файлы');
    assert.equal(
        skipText('rebase', { agents: { claude: none } }, agents),
        'Ревью не нужно: изменения те же, что на прошлом ревью (rebase или слияние целевой ветки). Итог прошлого ревью — 1 модель (Claude): замечаний нет',
    );
});

test('запись: POST с одним key, ссылкой на PR и обрезанным текстом; выключено или dry-run — ничего; ошибка не роняет ревью', async () => {
    const calls = [];
    const bitbucket = { postBuildStatus: async (...args) => calls.push(args) };
    const ctx = { config: { buildStatus: { enabled: true } }, bitbucket };
    assert.equal(await postBuildStatus(ctx, repo, pr, 'abc123', 'INPROGRESS', 'Проверяется'), true);
    await postBuildStatus(ctx, repo, pr, 'abc123', 'SUCCESSFUL', 'x'.repeat(400));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], [repo, 'abc123', { key: STATUS_KEY, state: 'INPROGRESS', name: 'AI-review', url: pr.links.html.href, description: 'Проверяется' }]);
    assert.equal(calls[1][2].key, STATUS_KEY);
    assert.equal(calls[1][2].description.length, 250);

    await postBuildStatus({ ...ctx, dryRun: true }, repo, pr, 'abc123', 'SUCCESSFUL', 'тест');
    await postBuildStatus({ ...ctx, config: {} }, repo, pr, 'abc123', 'SUCCESSFUL', 'тест');
    assert.equal(calls.length, 2);

    const failing = { ...ctx, bitbucket: { postBuildStatus: async () => { throw new Error('Bitbucket запретил запрос (403)'); } } };
    assert.equal(await postBuildStatus(failing, repo, pr, 'abc123', 'SUCCESSFUL', 'тест'), false);
    assert.equal(await postBuildStatus({ ...ctx, config: {} }, repo, pr, 'abc123', 'SUCCESSFUL', 'тест'), false);
});

test('лимит исчерпан: 100% и сброс впереди; сброс прошёл или остаток есть — доступна', async () => {
    const { DATA_DIR } = await import('../src/store.mjs');
    const { writeJson } = await import('../src/store.mjs');
    const { limitExhaustedUntil } = await import('../src/limits.mjs');
    const now = Date.parse('2026-11-23T10:00:00Z');
    writeJson(join(DATA_DIR, 'limits.json'), {
        cursor: { usedPercent: 100, resetsAt: '2026-11-30T11:36:34.000Z' },
        codex: { usedPercent: 100, resetsAt: '2026-11-22T00:00:00.000Z' },
        claude: { usedPercent: 99, resetsAt: '2026-11-27T10:00:00.000Z' },
    });
    assert.equal(limitExhaustedUntil('cursor', now).toISOString(), '2026-11-30T11:36:34.000Z');
    assert.equal(limitExhaustedUntil('codex', now), null);
    assert.equal(limitExhaustedUntil('claude', now), null);
    assert.equal(limitExhaustedUntil('other', now), null);
});
