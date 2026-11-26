// Расчёты вкладки «Статистика» — перенос menubar/StatsData.swift без изменений: те же фильтры, периоды и формулы
import type { Config, Lesson, WorkerState } from '../model/types';

export type Verdict = { target: string; verdict: string; reason?: string | null };
export type Usage = { inputTokens?: number; cachedTokens?: number; outputTokens?: number; costUsd?: number | null };

export type StatEntry = {
    at: string;
    repo: string;
    pr?: number | null;
    author?: string | null;
    agent: string;
    role: string;
    pass?: string | null;
    findings: Record<string, number>;
    verdicts: Verdict[];
    durationSec?: number | null;
    usage?: Usage | null;
    excludedBytes?: number | null;
    diffLines?: number | null;
    dropped?: number | null;
    backlogged?: number | null;
    filtered?: number | null;
    appliedLessons?: string[] | null;
    postedReplies?: number | null;
};

export type Outcome = { at: string; repo?: string | null; pr?: number | null; author?: string | null; agent: string; pass?: string | null; level: string; outcome: string; disputed?: boolean | null; hours?: number | null };
export type Skip = { at: string; repo: string; pr: number; author?: string | null; agent: string; reason: string };
export type SpendRecord = { at: string; kind: string; repo?: string | null; agent?: string | null; usage?: { costUsd?: number | null } | null };
export type FixRecord = { at: string; repo: string; pr: number; mode?: string | null; status: string; fixed?: number | null; skipped?: number | null; usage?: { costUsd?: number | null } | null };
export type ArchRecord = { at: string; repo: string; pr: number; agent?: string | null; verdict: string; usage?: { costUsd?: number | null } | null };
// У плана cases — число кейсов, у прогона — счётчики по статусам
export type QaRecord = { at: string; stage: string; repo: string; pr: number; cases?: number | Record<string, number> | null; bugs?: number | null; usage?: { costUsd?: number | null } | null };
export type BacklogItem = { id: string; repo: string; status: string; createdAt?: string | null; sources: { pr: number; agent: string }[] };
export type StatsLesson = Lesson & { source?: { mergedFrom?: string[] | null } | null; mergedFrom?: string[] | null };

export type StatsInput = {
    config: Config;
    state: WorkerState;
    stats: StatEntry[];
    outcomes: Outcome[];
    skips: Skip[];
    spend: SpendRecord[];
    fixLog: FixRecord[];
    archLog: ArchRecord[];
    qaLog: QaRecord[];
    backlog: BacklogItem[];
    memory: Record<string, StatsLesson[]>;
};

export type StatsFilter = { repo: string; author: string; agent: string; pass: string; days: number };

export const WORK_KINDS = ['review', 'replies', 'fix', 'rebase', 'arch', 'qa', 'memory', 'backlog'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];
export const WORK_TITLES: Record<WorkKind, string> = {
    review: 'Ревью',
    replies: 'Ответы в тредах',
    fix: 'Автофикс',
    rebase: 'Rebase',
    arch: 'Архитектура',
    qa: 'Тестирование',
    memory: 'Память',
    backlog: 'Бэклог',
};

export const LEVELS = ['P0', 'P1', 'P2', 'P3'];
export const DISAGREE_REASONS = ['wrong', 'fixed', 'preexisting', 'unlikely'];
// День, с которого действуют новые правила отбора: старые баги уходят в бэклог, редкие P3 не публикуются
export const SELECTION_RULES_DATE = new Date(2026, 9, 19);

export type Fate = { addressed: number; dismissed: number; disputed: number; waiting: number };
export const fateClosed = (fate: Fate) => fate.addressed + fate.dismissed;
export const fateTotal = (fate: Fate) => fateClosed(fate) + fate.waiting;
// Часть dismissed без ответа в треде: не стали править молча
export const fateIgnored = (fate: Fate) => fate.dismissed - fate.disputed;
const emptyFate = (): Fate => ({ addressed: 0, dismissed: 0, disputed: 0, waiting: 0 });

export type Density = { name: string; prs: number; lines: number; findings: Record<string, number>; total: number; density: number; isLowVolume: boolean };
export const perThousand = (row: Density, count: number) => (row.lines > 0 ? (count * 1000) / row.lines : 0);

export type DayValue = { day: number; group: string; value: number };
export type NoiseWeek = { week: number; addressed: number; dismissed: number };
export const weekClosed = (week: NoiseWeek) => week.addressed + week.dismissed;
export const weekShare = (week: NoiseWeek) => (weekClosed(week) > 0 ? week.dismissed / weekClosed(week) : 0);

export type AgentCost = { runs: number; seconds: number; tokens: number; cost: number; pricedRuns: number; inputTokens: number };

const parse = (iso: string | null | undefined) => {
    const time = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(time) ? null : new Date(time);
};
export const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), date.getSeconds());
// Недели с понедельника, как в русском календаре
export const weekOf = (date: Date) => addDays(startOfDay(date), -((date.getDay() + 6) % 7));

const findingCount = (entry: StatEntry) => Object.values(entry.findings).reduce((a, b) => a + b, 0);
const postedComments = (entry: StatEntry) => findingCount(entry) + (entry.postedReplies ?? entry.verdicts.filter((verdict) => verdict.verdict !== 'skip').length);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const isDismissed = (outcome: string) => outcome === 'dismissed' || outcome === 'unchanged';

export const statsData = (input: StatsInput, filter: StatsFilter, now = new Date()) => {
    const periodStart = addDays(startOfDay(now), -(filter.days - 1));
    const inPeriod = (iso: string | null | undefined) => {
        const date = parse(iso);
        return date && date >= periodStart ? date : null;
    };
    const matches = (repo: string | null | undefined, author: string | null | undefined, agent: string | null | undefined, pass: string | null | undefined) =>
        (!filter.repo || repo === filter.repo) && (!filter.author || author === filter.author) && (!filter.agent || agent === filter.agent) && (!filter.pass || pass === filter.pass);
    // Для работы помимо ревью: типа ревью у неё нет, а поле, которого у записи нет, фильтр не ограничивает
    const matchesWork = (repo: string | null | undefined, author: string | null | undefined, agent: string | null | undefined) =>
        matches(repo ?? filter.repo, author ?? filter.author, agent ?? filter.agent, filter.pass);

    const entries = input.stats.flatMap((entry) => {
        const date = matches(entry.repo, entry.author, entry.agent, entry.pass) ? inPeriod(entry.at) : null;
        return date ? [{ date, entry }] : [];
    });
    const outcomes = input.outcomes.filter((outcome) => matches(outcome.repo, outcome.author, outcome.agent, outcome.pass) && inPeriod(outcome.at));
    // «Ждут правки» — текущее состояние, период к нему не применяется
    const waiting = Object.entries(input.state.repos ?? {}).flatMap(([repo, state]) =>
        Object.values(state.prs)
            .flatMap((pr) => (pr.findings ?? []) as (TrackedFindingLike & { resolved?: boolean | null })[])
            .filter((finding) => finding.resolved !== true && matches(repo, finding.author, finding.agent, finding.pass))
            .map((finding) => ({ repo, finding })),
    );
    // Пропуск — несостоявшееся повторное ревью, поэтому в фильтре типа он относится к «после правок»
    const skips = input.skips.filter((skip) => matches(skip.repo, skip.author, skip.agent, 'followup') && inPeriod(skip.at));

    // Автора у записей автофикса, тестирования и архитектуры нет — берём автора PR из ревью
    const prAuthors = new Map<string, string>();
    for (const entry of input.stats) if (entry.pr != null && entry.author) prAuthors.set(`${entry.repo}#${entry.pr}`, entry.author);
    const authorOf = (repo: string, pr: number) => prAuthors.get(`${repo}#${pr}`) ?? 'неизвестно';
    // Автофикс и тестирование всегда идут через Claude (fix.mjs, qa.mjs), поэтому модели в их журналах нет
    const fixes = input.fixLog.filter((fix) => matchesWork(fix.repo, authorOf(fix.repo, fix.pr), 'claude') && inPeriod(fix.at));
    const archs = input.archLog.filter((arch) => matchesWork(arch.repo, authorOf(arch.repo, arch.pr), arch.agent) && inPeriod(arch.at));
    const qas = input.qaLog.filter((qa) => matchesWork(qa.repo, authorOf(qa.repo, qa.pr), 'claude') && inPeriod(qa.at));
    const spends = input.spend.flatMap((record) => {
        const date = matchesWork(record.repo || null, null, record.agent) ? inPeriod(record.at) : null;
        return date ? [{ date, record }] : [];
    });

    const spendings: { date: Date; kind: WorkKind; pr: string | null; cost: number }[] = [];
    const add = (date: Date | null, kind: WorkKind, pr: string | null, cost: number | null | undefined) => {
        if (date && cost != null) spendings.push({ date, kind, pr, cost });
    };
    for (const { date, entry } of entries) add(date, entry.pass === 'replies' ? 'replies' : 'review', entry.pr != null ? `${entry.repo}#${entry.pr}` : null, entry.usage?.costUsd);
    for (const fix of fixes) add(parse(fix.at), fix.mode === 'rebase' ? 'rebase' : 'fix', `${fix.repo}#${fix.pr}`, fix.usage?.costUsd);
    for (const arch of archs) add(parse(arch.at), 'arch', `${arch.repo}#${arch.pr}`, arch.usage?.costUsd);
    for (const qa of qas) add(parse(qa.at), 'qa', `${qa.repo}#${qa.pr}`, qa.usage?.costUsd);
    for (const { date, record } of spends) add(date, record.kind.startsWith('backlog') ? 'backlog' : 'memory', null, record.usage?.costUsd);

    const backlogItems = input.backlog.filter((item) => {
        if ((filter.repo && item.repo !== filter.repo) || !inPeriod(item.createdAt)) return false;
        return (!filter.agent || item.sources.some((source) => source.agent === filter.agent)) && (!filter.author || item.sources.some((source) => authorOf(item.repo, source.pr) === filter.author));
    });

    // Шум считаем по времени публикации замечания, а не закрытия PR: так видно, с каких замечаний подействовали новые правила
    const noiseOutcomes = input.outcomes.flatMap((outcome) => {
        const closedAt = parse(outcome.at);
        if (!closedAt || !matches(outcome.repo, outcome.author, outcome.agent, outcome.pass)) return [];
        const published = new Date(closedAt.getTime() - (outcome.hours ?? 0) * 3_600_000);
        return published >= periodStart ? [{ published, outcome }] : [];
    });

    // Первое ревью с новыми правилами: 19.10.2026 они включились не с полуночи, а с перезапуском сервиса
    const rulesStart = parse(input.stats.find((entry) => entry.backlogged != null)?.at) ?? SELECTION_RULES_DATE;

    const memory = { rules: 0, runs: 0, applied: 0, idle: null as number | null, since: null as Date | null };
    for (const { entry } of entries) {
        if (!entry.appliedLessons) continue;
        memory.runs += 1;
        memory.applied += new Set(entry.appliedLessons).size;
    }
    // Как `memory list`: учёт идёт с первого ревью репозитория с appliedLessons, склеенное правило наследует срабатывания исходных
    for (const slug of input.config.repos.map((repo) => repo.slug).filter((slug) => !filter.repo || slug === filter.repo)) {
        const lessons = input.memory[slug] ?? [];
        memory.rules += lessons.length;
        const tracked = input.stats.filter((entry) => entry.repo === slug && entry.appliedLessons != null);
        const first = parse(tracked[0]?.at);
        if (!first) continue;
        memory.since = memory.since && memory.since < first ? memory.since : first;
        const alias = new Map<string, string>();
        for (const lesson of lessons) for (const id of lesson.source?.mergedFrom ?? lesson.mergedFrom ?? []) if (!alias.has(id)) alias.set(id, lesson.id);
        const fired = new Set(tracked.flatMap((entry) => entry.appliedLessons ?? []).map((id) => alias.get(id) ?? id));
        memory.idle = (memory.idle ?? 0) + lessons.filter((lesson) => !fired.has(lesson.id)).length;
    }

    const dayRange = { start: periodStart, end: addDays(startOfDay(now), 1) };

    const perDay = (value: (item: { date: Date; entry: StatEntry }) => [number | null | undefined, string]): DayValue[] => {
        const sums = new Map<number, Map<string, number>>();
        for (const item of entries) {
            const [amount, group] = value(item);
            if (amount == null) continue;
            const day = startOfDay(item.date).getTime();
            const groups = sums.get(day) ?? new Map<string, number>();
            groups.set(group, (groups.get(group) ?? 0) + amount);
            sums.set(day, groups);
        }
        return flatten(sums);
    };

    const fate = (key: (repo: string | null | undefined, author: string | null | undefined, agent: string) => string) => {
        const result = new Map<string, Fate>();
        const of = (name: string) => result.get(name) ?? (result.set(name, emptyFate()), result.get(name)!);
        for (const outcome of outcomes) {
            const name = key(outcome.repo, outcome.author, outcome.agent);
            if (outcome.outcome === 'addressed') of(name).addressed += 1;
            // Прежний исход «влили без правки, тред открыт» теперь тоже считается отклонённым
            else if (isDismissed(outcome.outcome)) {
                of(name).dismissed += 1;
                if (outcome.disputed === true) of(name).disputed += 1;
            }
        }
        for (const item of waiting) of(key(item.repo, item.finding.author, item.finding.agent)).waiting += 1;
        return [...result.entries()].map(([name, value]) => ({ name, fate: value })).sort((a, b) => fateTotal(b.fate) - fateTotal(a.fate));
    };

    // Исправленные замечания из PR, где у модели были запуски с ценой. Цену ревью делим только на них
    const pricedAddressed = (agent?: string) => {
        const priced = new Set(entries.flatMap(({ entry }) => (entry.usage?.costUsd != null && entry.pr != null ? [`${entry.repo}#${entry.pr}#${entry.agent}`] : [])));
        return outcomes.filter((outcome) => outcome.outcome === 'addressed' && (!agent || outcome.agent === agent) && outcome.repo && outcome.pr != null && priced.has(`${outcome.repo}#${outcome.pr}#${outcome.agent}`)).length;
    };

    const agentCosts = () => {
        const result: Record<string, AgentCost> = {};
        for (const { entry } of entries) {
            const usage = entry.usage;
            if (!usage) continue;
            const row = (result[entry.agent] ??= { runs: 0, seconds: 0, tokens: 0, cost: 0, pricedRuns: 0, inputTokens: 0 });
            row.runs += 1;
            row.seconds += entry.durationSec ?? 0;
            row.tokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
            if (usage.costUsd != null) {
                row.cost += usage.costUsd;
                row.pricedRuns += 1;
                row.inputTokens += usage.inputTokens ?? 0;
            }
        }
        return result;
    };

    const fixRuns = fixes.filter((fix) => fix.mode !== 'rebase');

    return {
        filter,
        entries,
        outcomes,
        skips,
        fixes,
        archs,
        qas,
        spendings,
        backlogItems,
        memory,
        rulesStart,
        periodStart,
        dayRange,

        findingCount: sum(entries.map(({ entry }) => findingCount(entry))),

        // Замечания на 1000 изменённых строк: объём PR берём по последнему ревью, замечания — по всем ревью PR
        density(byAuthor: boolean): Density[] {
            const lines = new Map<string, Map<string, number>>();
            const found = new Map<string, Record<string, number>>();
            for (const { entry } of entries) {
                const group = byAuthor ? (entry.author ?? 'неизвестно') : entry.repo;
                if (entry.pr != null && entry.diffLines != null) {
                    const prs = lines.get(group) ?? new Map<string, number>();
                    const key = `${entry.repo}#${entry.pr}`;
                    prs.set(key, Math.max(prs.get(key) ?? 0, entry.diffLines));
                    lines.set(group, prs);
                }
                for (const [level, count] of Object.entries(entry.findings)) {
                    if (count <= 0) continue;
                    const levels = found.get(group) ?? {};
                    levels[level] = (levels[level] ?? 0) + count;
                    found.set(group, levels);
                }
            }
            return [...new Set([...lines.keys(), ...found.keys()])]
                .map((name) => {
                    const total = sum(Object.values(found.get(name) ?? {}));
                    const lineCount = sum([...(lines.get(name)?.values() ?? [])]);
                    return { name, prs: lines.get(name)?.size ?? 0, lines: lineCount, findings: found.get(name) ?? {}, total, density: lineCount > 0 ? (total * 1000) / lineCount : 0, isLowVolume: lineCount < 500 };
                })
                .sort((a, b) => Number(a.isLowVolume) - Number(b.isLowVolume) || b.density - a.density);
        },

        fate,
        overallFate: fate(() => '')[0]?.fate ?? emptyFate(),
        pricedAddressed,

        // Ревью кода по дням, без запусков «только ответы в тредах»: видно, что работа шла, даже если замечаний не было
        reviewsPerDay(): Map<number, number> {
            const result = new Map<number, number>();
            for (const { date, entry } of entries) {
                if (entry.pass === 'replies') continue;
                const day = startOfDay(date).getTime();
                result.set(day, (result.get(day) ?? 0) + 1);
            }
            return result;
        },

        commentsPerDay: (group: (entry: StatEntry) => string) => perDay(({ entry }) => [postedComments(entry) > 0 ? postedComments(entry) : null, group(entry)]),

        totalCost: sum(entries.map(({ entry }) => entry.usage?.costUsd ?? 0)),
        agentCosts,

        // Цена несостоявшегося раунда — средняя цена ревью этой модели (без ответов в тредах), по всем данным модели
        savedBySkips() {
            const average = new Map<string, number>();
            for (const agent of new Set(skips.map((skip) => skip.agent))) {
                const costs = input.stats.filter((entry) => entry.agent === agent && entry.pass !== 'replies').flatMap((entry) => (entry.usage?.costUsd != null ? [entry.usage.costUsd] : []));
                average.set(agent, costs.length ? sum(costs) / costs.length : 0);
            }
            return sum(skips.map((skip) => average.get(skip.agent) ?? 0));
        },

        // Примерно 4 байта на токен; токены не прочитаны моделью, но и не сэкономлены точно — это оценка
        excludedTokens: Math.floor(sum(entries.map(({ entry }) => entry.excludedBytes ?? 0)) / 4),
        excludedCost(costs: Record<string, AgentCost>) {
            return sum(
                entries.map(({ entry }) => {
                    const cost = costs[entry.agent];
                    const perToken = cost && cost.inputTokens > 0 && cost.pricedRuns > 0 ? cost.cost / cost.inputTokens : 0;
                    return ((entry.excludedBytes ?? 0) / 4) * perToken;
                }),
            );
        },

        totalSpend: sum(spendings.map((spending) => spending.cost)),
        costByKind() {
            const result: Partial<Record<WorkKind, { runs: number; cost: number }>> = {};
            for (const spending of spendings) {
                const row = (result[spending.kind] ??= { runs: 0, cost: 0 });
                row.runs += 1;
                row.cost += spending.cost;
            }
            return result;
        },
        spendPerDay(): DayValue[] {
            const sums = new Map<number, Map<string, number>>();
            for (const spending of spendings) {
                const day = startOfDay(spending.date).getTime();
                const groups = sums.get(day) ?? new Map<string, number>();
                groups.set(WORK_TITLES[spending.kind], (groups.get(WORK_TITLES[spending.kind]) ?? 0) + spending.cost);
                sums.set(day, groups);
            }
            return flatten(sums);
        },
        // Все траты, привязанные к PR: ревью, ответы, автофикс, rebase, архитектура, тестирование
        prSpend() {
            const linked = spendings.filter((spending) => spending.pr);
            return { cost: sum(linked.map((spending) => spending.cost)), prs: new Set(linked.map((spending) => spending.pr)).size };
        },

        fixRuns,
        fixStatuses() {
            const counts = new Map<string, number>();
            for (const fix of fixes) counts.set(fix.status, (counts.get(fix.status) ?? 0) + 1);
            return [...counts.entries()].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count);
        },
        fixedCount: sum(fixRuns.map((fix) => fix.fixed ?? 0)),
        fixSkipped: sum(fixRuns.map((fix) => fix.skipped ?? 0)),
        fixCost: sum(fixRuns.map((fix) => fix.usage?.costUsd ?? 0)),

        noiseWeeks(): NoiseWeek[] {
            const result = new Map<number, NoiseWeek>();
            for (const { published, outcome } of noiseOutcomes) {
                const week = weekOf(published).getTime();
                const row = result.get(week) ?? { week, addressed: 0, dismissed: 0 };
                if (outcome.outcome === 'addressed') row.addressed += 1;
                else if (isDismissed(outcome.outcome)) row.dismissed += 1;
                else continue;
                result.set(week, row);
            }
            return [...result.values()].sort((a, b) => a.week - b.week);
        },

        // Доля отклонённых до и после новых правил отбора
        noiseByRules() {
            const before = { week: periodStart.getTime(), addressed: 0, dismissed: 0 };
            const after = { week: rulesStart.getTime(), addressed: 0, dismissed: 0 };
            for (const { published, outcome } of noiseOutcomes) {
                const side = published >= rulesStart ? after : before;
                if (outcome.outcome === 'addressed') side.addressed += 1;
                else if (isDismissed(outcome.outcome)) side.dismissed += 1;
            }
            return { before, after };
        },

        // Что модели нашли, но не опубликовали; считается только по запускам с новыми полями
        selection() {
            const tracked = entries.map(({ entry }) => entry).filter((entry) => entry.backlogged != null);
            return {
                runs: tracked.length,
                published: sum(tracked.map(findingCount)),
                backlogged: sum(tracked.map((entry) => entry.backlogged ?? 0)),
                filtered: sum(tracked.map((entry) => entry.filtered ?? 0)),
                dropped: sum(tracked.map((entry) => entry.dropped ?? 0)),
            };
        },

        // Причины несогласия; у вердиктов до 19.10.2026 причины нет — они идут отдельным ключом unknown
        disagreeReasons() {
            let checked = 0;
            const reasons: Record<string, number> = {};
            for (const { entry } of entries)
                for (const verdict of entry.verdicts) {
                    if (verdict.verdict === 'skip') continue;
                    checked += 1;
                    if (verdict.verdict !== 'disagree') continue;
                    const reason = verdict.reason && DISAGREE_REASONS.includes(verdict.reason) ? verdict.reason : 'unknown';
                    reasons[reason] = (reasons[reason] ?? 0) + 1;
                }
            return { checked, reasons };
        },

        hoursToFix() {
            return LEVELS.flatMap((level) => {
                const hours = outcomes
                    .filter((outcome) => outcome.outcome === 'addressed' && outcome.hours != null && outcome.level === level)
                    .map((outcome) => outcome.hours!)
                    .sort((a, b) => a - b);
                if (!hours.length) return [];
                const middle = Math.floor(hours.length / 2);
                const median = hours.length % 2 === 1 ? hours[middle] : (hours[middle - 1] + hours[middle]) / 2;
                return [{ level, median, count: hours.length }];
            });
        },
    };
};

type TrackedFindingLike = { agent: string; author?: string | null; pass?: string | null };

export type StatsData = ReturnType<typeof statsData>;

const flatten = (sums: Map<number, Map<string, number>>): DayValue[] =>
    [...sums.entries()]
        .flatMap(([day, groups]) => [...groups.entries()].map(([group, value]) => ({ day, group, value })))
        .sort((a, b) => a.day - b.day || a.group.localeCompare(b.group));

// Роли в ревью и перекрёстная проверка — то же, что `pr-reviewer stats`, но по выбранному срезу
export type RoleStats = {
    firstRuns: number;
    firstFindings: Record<string, number>;
    secondRuns: number;
    secondFindings: Record<string, number>;
    confirmed: number;
    disputed: number;
    agreed: number;
    disagreed: number;
    skipped: number;
};

const merge = (into: Record<string, number>, from: Record<string, number>) => {
    for (const [key, value] of Object.entries(from)) into[key] = (into[key] ?? 0) + value;
};

export const roleStats = (data: StatsData, agentIds: string[]) => {
    const result: Record<string, RoleStats> = Object.fromEntries(
        agentIds.map((id) => [id, { firstRuns: 0, firstFindings: {}, secondRuns: 0, secondFindings: {}, confirmed: 0, disputed: 0, agreed: 0, disagreed: 0, skipped: 0 }]),
    );
    for (const { entry } of data.entries) {
        const row = result[entry.agent];
        if (!row) continue;
        if (entry.role === 'first') {
            row.firstRuns += 1;
            merge(row.firstFindings, entry.findings);
        } else if (entry.role === 'second') {
            row.secondRuns += 1;
            merge(row.secondFindings, entry.findings);
        }
        for (const verdict of entry.verdicts) {
            if (verdict.verdict === 'agree') row.agreed += 1;
            else if (verdict.verdict === 'disagree') row.disagreed += 1;
            else row.skipped += 1;
            // Вердикт модели — оценка замечаний той, кому она отвечала
            if (verdict.verdict === 'agree' && result[verdict.target]) result[verdict.target].confirmed += 1;
            if (verdict.verdict === 'disagree' && result[verdict.target]) result[verdict.target].disputed += 1;
        }
    }
    return result;
};
