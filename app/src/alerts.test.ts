import { describe, expect, it } from 'vitest';
import { checkAlerts, type AlertMemory } from './alerts';
import { DEFAULT_RULES, allows, levelsText, muteSummary, repoSummary, type NotificationSettings } from './model/notifications';
import { emptyData, type Data, type PullRequest } from './model/types';

const pr = (id: number, head: string, patch: Partial<PullRequest> & Record<string, unknown> = {}): PullRequest => ({ id, title: `PR ${id}`, draft: false, commentCount: 0, url: `u${id}`, head, source: 'PROJ-1', destination: 'develop', ...patch });
const memory = (patch: Partial<AlertMemory> = {}): AlertMemory => ({ since: { findings: '2026-11-26T10:00:00Z', comments: '2026-11-26T10:00:00Z', fixes: '2026-11-26T10:00:00Z' }, heads: {}, lastRunAt: undefined, stall: null, ...patch });
const settings: NotificationSettings = { all: { ...DEFAULT_RULES, enabled: ['findings', 'comments', 'updates', 'fixes', 'errors'] }, repos: {} };
const data = (patch: Partial<Data>): Data => ({ ...emptyData(), ...patch });
const name = (id: string) => id[0].toUpperCase() + id.slice(1);

describe('уведомления', () => {
    it('замечания — одно уведомление на запуск модели, только новые и не ниже уровня', () => {
        const findings = [
            { agent: 'claude', level: 'P1', title: 'Гонка', at: '2026-11-26T11:00:00Z' },
            { agent: 'claude', level: 'P1', title: 'Утечка', at: '2026-11-26T11:00:00Z' },
            { agent: 'claude', level: 'P2', title: 'Мелочь', at: '2026-11-26T11:00:00Z' },
            { agent: 'claude', level: 'P0', title: 'Старое', at: '2026-11-26T09:00:00Z' },
        ];
        const value = data({ snapshots: { front: { fetchedAt: '', prs: [pr(7, 'a')] } }, state: { repos: { front: { prs: { '7': { reviewed: {}, findings } } } } } as Data['state'] });
        const { notices, memory: next } = checkAlerts(value, settings, memory({ heads: { front: { 7: 'a' } } }), name);
        expect(notices.map((notice) => notice.title)).toEqual(['P1×2 в front #7 · Claude']);
        expect(notices[0]).toMatchObject({ subtitle: 'PR 7', body: 'P1: Гонка\nP1: Утечка', url: 'u7' });
        expect(next.since.findings).toBe('2026-11-26T11:00:00Z');
        expect(checkAlerts(value, settings, next, name).notices).toEqual([]);
    });

    it('обновления PR: новый, новые коммиты и закрытый; первый взгляд на репозиторий — только отсчёт', () => {
        const value = data({ snapshots: { front: { fetchedAt: '', prs: [pr(1, 'b'), pr(3, 'c')] } } });
        expect(checkAlerts(value, settings, memory(), name).notices).toEqual([]);
        const titles = checkAlerts(value, settings, memory({ heads: { front: { 1: 'a', 2: 'x' } } }), name).notices.map((notice) => notice.title);
        expect(titles).toEqual(['Новые коммиты в front #1', 'Новый PR front #3', 'PR front #2 закрыт']);
    });

    it('свой репозиторий без «Обновления PR» молчит, остальные — по общим правилам', () => {
        const own: NotificationSettings = { ...settings, repos: { front: { ...DEFAULT_RULES, enabled: ['findings'] } } };
        const value = data({ snapshots: { front: { fetchedAt: '', prs: [pr(3, 'c')] }, back: { fetchedAt: '', prs: [pr(4, 'd')] } } });
        const titles = checkAlerts(value, own, memory({ heads: { front: {}, back: {} } }), name).notices.map((notice) => notice.title);
        expect(titles).toEqual(['Новый PR back #4']);
        expect(allows(own, 'errors', 'front')).toBe(true);
        expect(repoSummary(own, 'front')).toBe('Свои · 1 из 5');
        expect(repoSummary(own, 'back')).toBe('Как для всех');
    });

    it('комментарии людей и итог доработки', () => {
        const comments = [{ id: 1, author: 'Анна', text: 'Почему так?', reply: false, at: '2026-11-26T11:00:00Z' }];
        const value = data({
            snapshots: { front: { fetchedAt: '', prs: [pr(7, 'a', { humanComments: comments })] } },
            fixes: [{ repo: 'front', pr: 7, state: 'done', mode: 'fix', report: { message: 'Запушено', fixed: [{ commentId: 1 }], skipped: [] }, finishedAt: '2026-11-26T11:30:00Z' } as Data['fixes'][number]],
        });
        const titles = checkAlerts(value, settings, memory({ heads: { front: { 7: 'a' } } }), name).notices.map((notice) => notice.title);
        expect(titles).toEqual(['Комментарий в front #7', 'Доработка front #7']);
    });

    it('ошибка прохода — только первая подряд и по новому проходу', () => {
        const status = (lastRunAt: string, errorStreak: number) => ({ phase: 'error', lastRunAt, errorStreak, lastError: 'нет сети' }) as Data['status'];
        const first = checkAlerts(data({ status: status('t1', 1) }), settings, memory(), name);
        expect(first.notices).toEqual([]);
        expect(checkAlerts(data({ status: status('t2', 1) }), settings, first.memory, name).notices.map((notice) => notice.title)).toEqual(['PR Reviewer: проход завершился с ошибкой']);
        expect(checkAlerts(data({ status: status('t2', 2) }), settings, { ...first.memory, lastRunAt: 't1' }, name).notices).toEqual([]);
    });

    it('сводка «Не беспокоить»', () => {
        const now = new Date('2026-11-26T12:00:00');
        expect(muteSummary('forever', now)).toBe('Выключены');
        expect(muteSummary(new Date('2026-11-26T16:00:00').toISOString(), now)).toBe('Выключены до 16:00');
    });

    it('уровни замечаний как в SwiftUI: по порядку, число только у повторов', () => {
        expect(levelsText({ P2: 2, P1: 1, P3: 0 })).toBe('P1 P2×2');
        expect(levelsText({})).toBe('');
    });
});
