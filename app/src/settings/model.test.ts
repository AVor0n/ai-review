import { describe, expect, it } from 'vitest';
import schema from '../../../schema/config.schema.json';
import type { TokenInfo } from '../model/derive';
import { configProblem, highlight } from './configText';
import { buildInfo, configPath, effortOptions, fieldDescription, limitView, modelChange, modelOptions, pathTitle, saveCommand, stepInterval, tokensSummary, tokenStatus, type Models } from './model';

const NOW = new Date('2026-11-26T12:00:00Z');
const models: Models = {
    codex: [
        { slug: 'gpt-a', display_name: 'GPT A', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], default_reasoning_level: 'low' },
        { slug: 'gpt-b', display_name: 'GPT B', supported_reasoning_levels: [{ effort: 'medium' }] },
    ],
    cursor: [{ id: 'opus-xhigh', title: 'Opus xhigh' }],
};
const token = (patch: Partial<TokenInfo>): TokenInfo => ({ id: 'bitbucket', title: 'Bitbucket', lifetimeDays: 365, expiresAt: null, daysLeft: null, isExpired: false, isExpiring: false, ...patch });

describe('настройки', () => {
    it('интервал шагает по разреженной шкале и не выходит за края', () => {
        expect(stepInterval(15, 1)).toBe(20);
        expect(stepInterval(15, -1)).toBe(10);
        expect(stepInterval(7, 1)).toBe(10);
        expect(stepInterval(240, 1)).toBeUndefined();
        expect(stepInterval(1, -1)).toBeUndefined();
    });

    it('модель из конфига, которой нет в списке, — первой; уровни Codex — из кэша', () => {
        expect(modelOptions('claude', 'claude-old', models)[0]).toEqual({ id: 'claude-old', title: 'claude-old' });
        expect(modelOptions('codex', 'gpt-a', models).map((option) => option.id)).toEqual(['gpt-a', 'gpt-b']);
        expect(effortOptions('codex', 'gpt-a', models).map((option) => option.id)).toEqual(['low', 'high']);
        expect(effortOptions('claude', 'opus', models)[0]).toEqual({ id: 'default', title: 'По умолчанию' });
    });

    it('у Codex неподдерживаемый уровень меняется на уровень новой модели по умолчанию', () => {
        expect(modelChange('codex', 'gpt-a', { shortName: 'Codex', reasoningEffort: 'medium' }, models)).toEqual({ model: 'gpt-a', effort: 'low', label: 'Codex GPT A' });
        expect(modelChange('codex', 'gpt-a', { shortName: 'Codex', reasoningEffort: 'high' }, models).effort).toBeUndefined();
        expect(modelChange('codex', 'gpt-b', { shortName: 'Codex', reasoningEffort: 'high' }, models).effort).toBe('medium');
        expect(modelChange('claude', 'opus', undefined, models)).toEqual({ model: 'opus', label: 'Claude Opus' });
        expect(modelChange('cursor', 'opus-xhigh', undefined, models).label).toBe('Cursor Opus xhigh');
    });

    it('строка лимита: свежий, устаревший, сброшенный, без данных', () => {
        const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
        expect(limitView('codex', { usedPercent: 38, window: 'week', at: at(5), resetsAt: '2026-12-01T10:00:00Z' }, 'Codex', NOW)).toMatchObject({ bar: 62, low: false, text: '62% недели осталось · до 1 дек.' });
        expect(limitView('codex', { usedPercent: 94, at: at(5), resetsAt: '2026-12-01T10:00:00Z' }, 'Codex', NOW)).toMatchObject({ low: true });
        expect(limitView('codex', { usedPercent: 96, at: at(120), resetsAt: '2026-12-01T10:00:00Z', error: { text: 'нет сети' } }, 'Codex', NOW)).toMatchObject({ stale: true, warning: true });
        expect(limitView('codex', { usedPercent: 96, at: at(120), resetsAt: at(10) }, 'Codex', NOW).text).toBe('лимит сброшен, остаток обновится');
        expect(limitView('claude', { usedPercent: 10, at: at(600), resetsAt: at(10) }, 'Claude', NOW).text).toBe('лимит сброшен');
        expect(limitView('cursor', undefined, 'Cursor', NOW)).toMatchObject({ none: true, text: 'лимит недоступен' });
        expect(limitView('claude', undefined, 'Claude', NOW).text).toBe('лимит появится после ближайшего запуска');
    });

    it('сводка и статус токенов', () => {
        const expires = new Date('2026-12-01T00:00:00Z');
        expect(tokensSummary([token({ isExpired: true, title: 'Cursor' }), token({ isExpiring: true, daysLeft: 5 })], NOW)).toEqual({ text: 'Cursor: истёк', color: 'var(--red)' });
        expect(tokensSummary([token({ isExpiring: true, daysLeft: 5 })], NOW)).toEqual({ text: 'Bitbucket: 5 дн.', color: 'var(--orange)' });
        expect(tokensSummary([token({ expiresAt: expires })], NOW).text).toBe('до 1 дек.');
        expect(tokenStatus(token({}), null, NOW)).toEqual({ text: 'Не сохранён', color: 'var(--red)' });
        expect(tokenStatus(token({ expiresAt: expires, daysLeft: 5, isExpiring: true }), new Date('2025-12-01T00:00:00Z'), NOW)).toEqual({ text: 'Сохранён 1 дек. 2025 г. · до 1 дек., осталось 5 дн.', color: 'var(--orange)' });
        expect(saveCommand(token({}), 'svc', 'me@example.com', 'win', '~/tools/pr-reviewer/bin/pr-reviewer')).toBe('~/tools/pr-reviewer/bin/pr-reviewer secret set bitbucket');
        expect(saveCommand(token({}), 'svc', 'me@example.com', 'mac', '')).toContain('security add-generic-password -U -s svc -a me@example.com');
    });

    it('путь поля под курсором и его описание из схемы', () => {
        const text = '{\n  "memory": { "maxLessons": 60 },\n  "repos": [ { "slug": "a" } ]\n}';
        const memory = configPath(text, text.indexOf('60'));
        expect(memory).toEqual(['memory', 'maxLessons']);
        expect(pathTitle(memory)).toBe('memory.maxLessons');
        expect(fieldDescription(schema, memory)).toMatch(/правил/);
        const slug = configPath(text, text.indexOf('"a"'));
        expect(pathTitle(slug)).toBe('repos[].slug');
        expect(configPath(text, 1)).toEqual([]);
    });

    it('проверка config.json до записи: синтаксис и схема, первая проблема и сколько ещё', () => {
        expect(configProblem('{ "repos": ')).toBeTruthy();
        expect(configProblem(JSON.stringify({ repos: [], agents: {}, intervalMinutes: 'часто', extra: 1 }))).toMatch(/\(и ещё \d+\)$/);
    });

    it('подсветка JSON: ключи, строки, числа, true/false и знаки', () => {
        const kinds = highlight('{"a": "b", "n": 12, "t": true}').filter((token) => token.kind).map((token) => `${token.kind}:${token.text.trim()}`);
        expect(kinds).toEqual(['p:{', 'k:"a"', 'p::', 's:"b"', 'p:,', 'k:"n"', 'p::', 'n:12', 'p:,', 'k:"t"', 'p::', 'b:true', 'p:}']);
    });

    it('строка сборки: год — только если не текущий', () => {
        expect(buildInfo('3694b44abc', '2026-11-25T11:05:00Z', true, NOW)).toMatchObject({ dirty: true });
        expect(buildInfo('3694b44abc', '2026-11-25T11:05:00Z', false, NOW)?.text).toMatch(/^Сборка 3694b44 · 25\.11 \d\d:05$/);
        expect(buildInfo('', '2025-11-25T11:05:00Z', true, NOW)).toMatchObject({ dirty: false, text: expect.stringMatching(/^Сборка от 25\.11\.2025 /) });
    });
});
