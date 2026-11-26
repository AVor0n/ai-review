import { describe, expect, it } from 'vitest';
import { roleStats, statsData, weekOf, type StatEntry, type StatsInput } from './data';
import { decimal, duration, hours, levelCount, money, shareText } from './format';

const NOW = new Date(2026, 10, 26, 12, 0);
const at = (daysAgo: number, hour = 10) => new Date(2026, 10, 26 - daysAgo, hour).toISOString();

const entry = (patch: Partial<StatEntry>): StatEntry => ({ at: at(1), repo: 'front', pr: 1, author: 'anna', agent: 'claude', role: 'first', pass: 'initial', findings: {}, verdicts: [], ...patch });

const input = (patch: Partial<StatsInput> = {}): StatsInput => ({
    config: { repos: [{ workspace: 'w', slug: 'front' }, { workspace: 'w', slug: 'back' }], agents: { claude: { shortName: 'Claude' }, codex: { shortName: 'Codex' } } },
    state: {},
    stats: [],
    outcomes: [],
    skips: [],
    spend: [],
    fixLog: [],
    archLog: [],
    qaLog: [],
    backlog: [],
    memory: {},
    ...patch,
});

const filter = { repo: '', author: '', agent: '', pass: '', days: 30 };

describe('расчёты статистики — как StatsData.swift', () => {
    it('период: последние N дней от полуночи, старые записи не входят', () => {
        const data = statsData(input({ stats: [entry({ at: at(1), findings: { P1: 2 } }), entry({ at: at(40), findings: { P0: 5 } })] }), filter, NOW);
        expect(data.findingCount).toBe(2);
        expect(data.dayRange.start).toEqual(new Date(2026, 9, 28));
    });

    it('судьба: «влили без правки» — тоже отклонено, ждущие правки — из состояния без периода', () => {
        const data = statsData(
            input({
                outcomes: [
                    { at: at(2), repo: 'front', agent: 'claude', level: 'P1', outcome: 'addressed' },
                    { at: at(2), repo: 'front', agent: 'claude', level: 'P2', outcome: 'unchanged', disputed: true },
                    { at: at(2), repo: 'front', agent: 'codex', level: 'P2', outcome: 'dismissed' },
                ],
                state: { repos: { front: { prs: { '1': { reviewed: {}, findings: [{ agent: 'codex', level: 'P1', title: 't', at: at(50) }] } } } } },
            }),
            filter,
            NOW,
        );
        expect(data.fate((_, __, agent) => agent)).toEqual([
            { name: 'claude', fate: { addressed: 1, dismissed: 1, disputed: 1, waiting: 0 } },
            { name: 'codex', fate: { addressed: 0, dismissed: 1, disputed: 0, waiting: 1 } },
        ]);
    });

    it('плотность: объём PR по последнему ревью, мало данных — в конце', () => {
        const data = statsData(
            input({
                stats: [
                    entry({ author: 'anna', pr: 1, diffLines: 800, findings: { P1: 2 } }),
                    entry({ author: 'anna', pr: 1, diffLines: 1000, findings: { P2: 1 } }),
                    entry({ author: 'oleg', pr: 2, diffLines: 300, findings: { P0: 3 } }),
                ],
            }),
            filter,
            NOW,
        );
        const rows = data.density(true);
        expect(rows.map((row) => [row.name, row.lines, row.total, row.isLowVolume])).toEqual([
            ['anna', 1000, 3, false],
            ['oleg', 300, 3, true],
        ]);
        expect(rows[0].density).toBe(3);
    });

    it('пропуск относится к «после правок», тип «первое ревью» его отбрасывает', () => {
        const skips = [{ at: at(1), repo: 'front', pr: 1, agent: 'claude', reason: 'rebase' }];
        expect(statsData(input({ skips }), { ...filter, pass: 'followup' }, NOW).skips).toHaveLength(1);
        expect(statsData(input({ skips }), { ...filter, pass: 'initial' }, NOW).skips).toHaveLength(0);
    });

    it('медиана часов до исправления по уровням', () => {
        const outcomes = [3, 1, 2, 10].map((value) => ({ at: at(1), agent: 'claude', level: 'P1', outcome: 'addressed', hours: value }));
        expect(statsData(input({ outcomes }), filter, NOW).hoursToFix()).toEqual([{ level: 'P1', median: 2.5, count: 4 }]);
    });

    it('траты по видам работы и цена PR', () => {
        const data = statsData(
            input({
                stats: [entry({ usage: { costUsd: 1 } }), entry({ pass: 'replies', usage: { costUsd: 0.5 } })],
                fixLog: [{ at: at(1), repo: 'front', pr: 1, status: 'pushed', fixed: 2, usage: { costUsd: 2 } }],
                spend: [{ at: at(1), kind: 'memory-review', usage: { costUsd: 0.25 } }],
            }),
            filter,
            NOW,
        );
        expect(data.costByKind()).toEqual({ review: { runs: 1, cost: 1 }, replies: { runs: 1, cost: 0.5 }, fix: { runs: 1, cost: 2 }, memory: { runs: 1, cost: 0.25 } });
        expect(data.prSpend()).toEqual({ cost: 3.5, prs: 1 });
        expect(data.fixedCount).toBe(2);
    });

    it('шум по неделе публикации и отбор по новым правилам', () => {
        const data = statsData(
            input({
                outcomes: [
                    { at: at(1), agent: 'claude', level: 'P1', outcome: 'dismissed', hours: 24 },
                    { at: at(1), agent: 'claude', level: 'P1', outcome: 'addressed', hours: 1 },
                ],
                stats: [entry({ findings: { P1: 3 }, backlogged: 1, filtered: 2, dropped: 0 })],
            }),
            filter,
            NOW,
        );
        expect(data.noiseWeeks()).toEqual([{ week: weekOf(new Date(2026, 10, 24)).getTime(), addressed: 1, dismissed: 1 }]);
        expect(data.selection()).toEqual({ runs: 1, published: 3, backlogged: 1, filtered: 2, dropped: 0 });
    });

    it('перекрёстная проверка: согласие модели — подтверждение для той, кому она отвечала', () => {
        const data = statsData(input({ stats: [entry({ agent: 'codex', role: 'second', verdicts: [{ target: 'claude', verdict: 'agree' }, { target: 'claude', verdict: 'disagree', reason: 'wrong' }] })] }), filter, NOW);
        const roles = roleStats(data, ['claude', 'codex']);
        expect(roles.claude).toMatchObject({ confirmed: 1, disputed: 1 });
        expect(roles.codex).toMatchObject({ secondRuns: 1, agreed: 1, disagreed: 1 });
        expect(data.disagreeReasons()).toEqual({ checked: 2, reasons: { wrong: 1 } });
    });
});

describe('числа статистики', () => {
    it('деньги, доли, время и склонения', () => {
        expect(money(184.2)).toBe('$184.20');
        expect(shareText(118, 159)).toBe('74% · 118/159');
        expect(duration(220)).toBe('3 мин 40 с');
        expect(hours(2.4)).toBe('2,4 ч');
        expect(hours(19.2)).toBe('19 ч');
        expect(hours(55)).toBe('2,3 дн.');
        expect(decimal(1.8)).toBe('1,8');
        expect(levelCount('P1', 9)).toBe('9 важных замечаний');
        expect(levelCount('P0', 1)).toBe('1 критичное замечание');
    });
});
