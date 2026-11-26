import { describe, expect, it } from 'vitest';
import type { Config } from '../model/types';
import { closeReason, fileUrl, groups, isStale, lastScan, prSources, sourceKind, triageHeading, type BacklogItem } from './model';

const item = (patch: Partial<BacklogItem>): BacklogItem => ({ id: 'a', repo: 'frontend', status: 'open', level: 'P2', title: 'Проблема', sources: [{ pr: 1, url: 'u', agent: 'claude' }], ...patch });
const config: Config = { repos: [{ workspace: 'team', slug: 'frontend' }, { workspace: 'team', slug: 'backend' }], agents: {} };

describe('бэклог', () => {
    it('группы в порядке обзора, отключённые репозитории в конце; в «Ждут разбора» только открытые', () => {
        const items = [item({ id: '1', repo: 'old' }), item({ id: '2', repo: 'backend' }), item({ id: '3', repo: 'frontend', status: 'filed' }), item({ id: '4', repo: 'frontend' })];
        expect(groups(items, false, ['frontend', 'backend']).map((group) => [group.repo, group.items.map((entry) => entry.id)])).toEqual([
            ['frontend', ['4']],
            ['backend', ['2']],
            ['old', ['1']],
        ]);
    });

    it('в «Все» сначала открытые, дальше по уровню и числу источников', () => {
        const items = [
            item({ id: 'closed', status: 'dropped', level: 'P0' }),
            item({ id: 'p2', level: 'P2' }),
            item({ id: 'p1-once', level: 'P1' }),
            item({ id: 'p1-twice', level: 'P1', sources: [{ pr: 1, url: 'u', agent: 'claude' }, { pr: 2, url: 'u', agent: 'codex' }] }),
        ];
        expect(groups(items, true, ['frontend'])[0].items.map((entry) => entry.id)).toEqual(['p1-twice', 'p1-once', 'p2', 'closed']);
    });

    it('неактуальна только открытая запись с вердиктом «решено», «удалено» или «не баг»', () => {
        const triage = (verdict: string) => ({ at: '2026-11-20T00:00:00Z', verdict, reason: 'исправлено в #5' });
        expect(isStale(item({ triage: triage('fixed') }))).toBe(true);
        expect(isStale(item({ triage: triage('actual') }))).toBe(false);
        expect(isStale(item({ status: 'dropped', triage: triage('gone') }))).toBe(false);
        expect(closeReason(triage('invalid'))).toBe('Неактуально (не баг): исправлено в #5');
    });

    it('ссылка на файл — на коммите последнего источника со строкой, без коммита ссылки нет', () => {
        const sources = [{ pr: 1, url: 'u', agent: 'claude', commit: 'aaa' }, { pr: 2, url: 'u', agent: 'codex', commit: 'bbb' }, { pr: 3, url: 'u', agent: 'human' }];
        expect(fileUrl(item({ path: 'src/a b.ts', line: 8, sources }), config)).toBe('https://bitbucket.org/team/frontend/src/bbb/src/a%20b.ts#lines-8');
        expect(fileUrl(item({ path: 'src/a.ts' }), config)).toBeNull();
        expect(fileUrl(item({ path: 'src/a.ts', triage: { at: '', verdict: 'actual', reason: '', commit: 'ccc' } }), config)).toBe('https://bitbucket.org/team/frontend/src/ccc/src/a.ts');
    });

    it('PR без повторов и формулировки источников', () => {
        const sources = [{ pr: 1, url: 'u', agent: 'claude' }, { pr: 1, url: 'u', agent: 'codex', kind: 'reply' }, { pr: 2, url: 'u', agent: 'human', kind: 'history' }];
        expect(prSources(item({ sources })).map((source) => source.pr)).toEqual([1, 2]);
        expect(sources.map(sourceKind)).toEqual(['нашла при ревью', 'признала старой проблемой замечание в треде', 'из незакрытого треда влитого PR']);
    });

    it('строка о последнем сборе без хвоста про повторный запуск', () => {
        expect(lastScan(null)).toBeNull();
        expect(lastScan({ repos: { a: { at: '2026-11-20T15:40:00Z', found: 3 }, b: { at: '2026-11-19T10:00:00Z', found: 4 } } })).toMatch(/^Последний разбор истории — 20 нояб\. 2026 г\., \d\d:40, найдено 7$/);
        expect(lastScan({ repos: { a: { at: '2026-11-20T15:40:00Z', found: 0 } } })).toMatch(/ничего не найдено$/);
    });

    it('заголовок разбора: вердикт с заглавной, ветка и короткий коммит', () => {
        const now = new Date('2026-11-20T12:00:00Z');
        expect(triageHeading({ at: '2026-11-20T10:00:00Z', verdict: 'fixed', reason: '', branch: 'develop', commit: '5e81d0c9f' }, now)).toBe('Решено · разбор по коду · 2 часа назад · develop 5e81d0c');
    });
});
