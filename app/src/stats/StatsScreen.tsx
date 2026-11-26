import { CheckMenuItem, Menu, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApiClient } from '../api/client';
import { Icon } from '../components/Icon';
import { agentIds, agentName } from '../model/derive';
import type { Data } from '../model/types';
import { formatDate } from '../model/format';
import { getLang, t, useLang, type MessageKey } from '../i18n';
import { DailyChart, NoiseChart, type Series } from './Charts';
import {
    DISAGREE_REASONS,
    LEVELS,
    SELECTION_RULES_DATE,
    WORK_KINDS,
    fateClosed,
    fateIgnored,
    roleStats,
    statsData,
    weekOf,
    workTitle,
    type ArchRecord,
    type BacklogItem,
    type FixRecord,
    type Outcome,
    type QaRecord,
    type Skip,
    type SpendRecord,
    type StatEntry,
    type StatsData,
    type StatsInput,
    type StatsLesson,
} from './data';
import { dayFull, decimal, duration, hours, money, percent, shareText } from './format';
import { loadStatsPrefs, saveStatsPrefs, type Dimension, type StatsPrefs } from './prefs';
import { Card, DensityRow, Dot, Empty, FateRow, Kpi, Rows, Segments, ShareRow, StatLine, Title, levelColor } from './rows';
import { exportImage } from './exportImage';

type Journals = Pick<StatsInput, 'stats' | 'outcomes' | 'skips' | 'spend' | 'fixLog' | 'archLog' | 'qaLog' | 'backlog'>;

const passes = () => (['initial', 'followup', 'replies'] as const).map((id) => ({ id, title: t(`stats.pass.${id}`) }));
const dimensions = (): { id: Dimension; title: string }[] => (['agent', 'repo', 'author'] as const).map((id) => ({ id, title: t(`stats.dimension.${id}`) }));
// Цвет репозитория и автора — по месту в стабильном отсортированном списке, а не в отфильтрованном
const seriesColor = (index: number) => `var(--chart-${(index % 8) + 1})`;

const FIX_STATUSES: Record<string, [MessageKey, string]> = {
    pushed: ['stats.autofix.status.pushed', 'var(--fate-addressed)'],
    nothing: ['stats.autofix.status.nothing', 'var(--level-p3)'],
    'commit-failed': ['stats.autofix.status.commitFailed', 'var(--fate-dismissed)'],
    'checks-failed': ['stats.autofix.status.checksFailed', 'var(--level-p2)'],
    'rebase-failed': ['stats.autofix.status.rebaseFailed', 'var(--level-p0)'],
    'push-rejected': ['stats.autofix.status.pushRejected', 'var(--level-p1)'],
};
const REASON_COLORS = {
    wrong: 'var(--level-p0)',
    fixed: 'var(--fate-addressed)',
    preexisting: 'var(--fate-waiting)',
    unlikely: 'var(--level-p2)',
    unknown: 'var(--level-p3)',
} as const;
type ReasonKey = keyof typeof REASON_COLORS;
const VERDICTS = [
    ['keep', 'var(--green)'],
    ['discuss', 'var(--yellow)'],
    ['rework', 'var(--orange)'],
] as const;
const QA_STATUSES = [
    ['failed', 'var(--red)'],
    ['unconfirmed', 'var(--yellow)'],
    ['blocked', 'var(--orange)'],
    ['passed', 'var(--green)'],
    ['skipped', 'var(--gray)'],
] as const;
// Дата новых правил отбора в подписях: «19.10» и «19.10.2026», в английском — «19 Oct» и «19 Oct 2026»
const rulesDay = () => formatDate(SELECTION_RULES_DATE, getLang() === 'ru' ? { day: '2-digit', month: '2-digit' } : { day: 'numeric', month: 'short' });
const rulesDate = () => formatDate(SELECTION_RULES_DATE, getLang() === 'ru' ? { day: '2-digit', month: '2-digit', year: 'numeric' } : { day: 'numeric', month: 'short', year: 'numeric' });

const loadJournals = async (api: ApiClient): Promise<Journals> => {
    const [stats, outcomes, skips, spend, fixLog, archLog, qaLog, backlog] = await Promise.all([
        api.GET('/stats'),
        api.GET('/outcomes'),
        api.GET('/skips'),
        api.GET('/spend'),
        api.GET('/fixes/history'),
        api.GET('/arch/history'),
        api.GET('/qa/history'),
        api.GET('/backlog'),
    ]);
    return {
        stats: (stats.data ?? []) as StatEntry[],
        outcomes: (outcomes.data ?? []) as Outcome[],
        skips: (skips.data ?? []) as Skip[],
        spend: (spend.data ?? []) as SpendRecord[],
        fixLog: (fixLog.data ?? []) as FixRecord[],
        archLog: (archLog.data ?? []) as ArchRecord[],
        qaLog: (qaLog.data ?? []) as QaRecord[],
        backlog: ((backlog.data as { items?: BacklogItem[] } | undefined)?.items ?? []) as BacklogItem[],
    };
};

// Фильтр открывает системное меню: «Все …», разделитель, варианты, у выбранного — галочка
const openFilter = async (allTitle: string, options: { id: string; title: string }[], value: string, onChange: (value: string) => void) => {
    const items = await Promise.all([
        CheckMenuItem.new({ text: allTitle, checked: value === '', action: () => onChange('') }),
        PredefinedMenuItem.new({ item: 'Separator' }),
        ...options.map((option) => CheckMenuItem.new({ text: option.title, checked: option.id === value, action: () => onChange(option.id) })),
    ]);
    const menu = await Menu.new({ items });
    await menu.popup();
};

const Filter = ({ icon, allTitle, options, value, onChange }: { icon: string; allTitle: string; options: { id: string; title: string }[]; value: string; onChange: (value: string) => void }) => {
    const selected = options.find((option) => option.id === value);
    return (
        <button className={`filter${selected ? ' filter--active' : ''}`} onClick={() => openFilter(allTitle, options, value, onChange).catch(() => {})}>
            <Icon id={icon} />
            {selected?.title ?? allTitle}
            <Icon id="i-chevron-down" className="icon filter__chevron" />
        </button>
    );
};

export const StatsScreen = ({ api, data, version }: { api: ApiClient | null; data: Data; version: number }) => {
    const [journals, setJournals] = useState<Journals | null>(null);
    const [prefs, setPrefs] = useState<StatsPrefs>(loadStatsPrefs);
    const [saving, setSaving] = useState(false);
    const lang = useLang();
    const content = useRef<HTMLDivElement>(null);

    // Журналы читаются при открытии вкладки и по событиям сервиса, пока она открыта
    useEffect(() => {
        if (!api) return;
        let current = true;
        loadJournals(api).then((loaded) => current && setJournals(loaded));
        return () => {
            current = false;
        };
    }, [api, version]);

    const update = (patch: Partial<StatsPrefs>) =>
        setPrefs((previous) => {
            const next = { ...previous, ...patch };
            saveStatsPrefs(next);
            return next;
        });

    const ids = agentIds(data.config);
    const authors = useMemo(() => [...new Set([...(journals?.stats ?? []).flatMap((entry) => (entry.author ? [entry.author] : [])), ...(journals?.outcomes ?? []).flatMap((outcome) => (outcome.author ? [outcome.author] : []))])].sort(), [journals]);
    const stats = useMemo(
        () => (journals ? statsData({ ...journals, config: data.config, state: data.state, memory: data.memory as Record<string, StatsLesson[]> }, { repo: prefs.repo, author: prefs.author, agent: prefs.agent, pass: prefs.pass, days: prefs.days }) : null),
        [journals, data.config, data.state, data.memory, prefs, lang],
    );

    const save = async () => {
        if (!content.current || saving) return;
        setSaving(true);
        await exportImage(content.current, 'pr-reviewer-stats').catch(() => {});
        setSaving(false);
    };

    return (
        <div className="screen">
            <div className="filter-bar">
                <Filter icon="i-repo" allTitle={t('stats.filter.allRepos')} options={data.config.repos.map((repo) => ({ id: repo.slug, title: repo.slug }))} value={prefs.repo} onChange={(repo) => update({ repo })} />
                <Filter icon="i-person" allTitle={t('stats.filter.allAuthors')} options={authors.map((author) => ({ id: author, title: author }))} value={prefs.author} onChange={(author) => update({ author })} />
                <Filter icon="i-model" allTitle={t('stats.filter.allModels')} options={ids.map((id) => ({ id, title: agentName(data.config, id) }))} value={prefs.agent} onChange={(agent) => update({ agent })} />
                <Filter icon="i-pass" allTitle={t('stats.filter.anyPass')} options={passes()} value={prefs.pass} onChange={(pass) => update({ pass })} />
                <span className="spacer" />
                <div className="segmented segmented--compact">
                    {[7, 30, 90].map((days) => (
                        <button key={days} className="segmented__item" aria-selected={prefs.days === days} onClick={() => update({ days })}>
                            {t('stats.days', { count: days })}
                        </button>
                    ))}
                </div>
                <button className="square-button" title={t('stats.filter.saveImage')} disabled={!stats || saving} onClick={save}>
                    <Icon id={saving ? 'i-spinner' : 'i-camera'} />
                </button>
            </div>
            <div className="scroll">
                <div className="stats" ref={content}>
                    {stats && <Sections stats={stats} data={data} prefs={prefs} update={update} authors={authors} />}
                </div>
            </div>
        </div>
    );
};

const Sections = ({ stats, data, prefs, update, authors }: { stats: StatsData; data: Data; prefs: StatsPrefs; update: (patch: Partial<StatsPrefs>) => void; authors: string[] }) => {
    const ids = agentIds(data.config);
    const name = (id: string) => agentName(data.config, id);
    const fate = stats.overallFate;
    const repos = data.config.repos.map((repo) => repo.slug);

    // ----- Ревью -----
    const commentNames = prefs.commentsBy === 'agent' ? ids.map(name) : prefs.commentsBy === 'repo' ? repos : authors;
    const commentSeries: Series[] = commentNames.map((item, index) => ({
        name: item,
        color: prefs.commentsBy === 'agent' ? `var(--model-${ids[index]})` : seriesColor(index),
    }));
    const comments = stats.commentsPerDay((entry) => (prefs.commentsBy === 'agent' ? name(entry.agent) : prefs.commentsBy === 'repo' ? entry.repo : (entry.author ?? t('stats.unknown'))));
    const fates = stats.fate((repo, author, agent) => (prefs.fateBy === 'agent' ? agent : prefs.fateBy === 'repo' ? (repo ?? t('stats.unknown')) : (author ?? t('stats.unknown'))));

    // ----- Шум -----
    const rules = stats.noiseByRules();
    const selection = stats.selection();
    const found = selection.published + selection.backlogged + selection.filtered + selection.dropped;
    const reasons = stats.disagreeReasons();
    const disagreed = Object.values(reasons.reasons).reduce((a, b) => a + b, 0);

    // ----- Качество -----
    const density = stats.density(prefs.densityBy === 'author');
    const maxDensity = Math.max(...(density.some((row) => !row.isLowVolume) ? density.filter((row) => !row.isLowVolume) : density).map((row) => row.density), 0) || 1;

    // ----- Время -----
    const toFix = stats.hoursToFix();
    const longest = Math.max(...toFix.map((row) => row.median), 0) || 1;

    // ----- Стоимость -----
    const prSpend = stats.prSpend();
    const pricedAddressed = stats.pricedAddressed();
    const byKind = stats.costByKind();
    const kinds = WORK_KINDS.filter((kind) => (byKind[kind]?.runs ?? 0) > 0).sort((a, b) => byKind[b]!.cost - byKind[a]!.cost);
    const kindSeries: Series[] = WORK_KINDS.map((kind, index) => ({ name: workTitle(kind), color: seriesColor(index) }));

    // ----- Автофикс -----
    const statuses = stats.fixStatuses();
    const rebases = stats.fixes.length - stats.fixRuns.length;

    // ----- Режимы -----
    const plans = stats.qas.filter((qa) => qa.stage === 'plan');
    const runs = stats.qas.filter((qa) => qa.stage === 'run');
    const caseCounts: Record<string, number> = {};
    for (const run of runs) if (run.cases && typeof run.cases === 'object') for (const [status, count] of Object.entries(run.cases)) caseCounts[status] = (caseCounts[status] ?? 0) + count;
    const verdicts: Record<string, number> = {};
    for (const arch of stats.archs) verdicts[arch.verdict] = (verdicts[arch.verdict] ?? 0) + 1;
    const memory = stats.memory;
    const backlog = stats.backlogItems;

    // ----- Сравнение -----
    const roles = roleStats(stats, ids);
    const costs = stats.agentCosts();
    const fateByAgent = Object.fromEntries(stats.fate((_, __, agent) => agent).map((row) => [row.name, row.fate]));
    const perRun = (findings: Record<string, number>, count: number) => (count > 0 ? decimal(Object.values(findings).reduce((a, b) => a + b, 0) / count) : '—');
    const given = (row: (typeof roles)[string], count: number) => shareText(count, row.agreed + row.disagreed + row.skipped);
    // Знаменатель — закрытые замечания модели: ждущие правки ещё ничего не говорят о качестве
    const share = (id: string, part: 'addressed' | 'ignored' | 'disputed') => {
        const row = fateByAgent[id];
        if (!row || fateClosed(row) === 0) return '—';
        return shareText(part === 'ignored' ? fateIgnored(row) : row[part], fateClosed(row));
    };
    const compareRow = (title: string, values: string[], levels?: Record<string, number>[]) => (
        <div className="compare__row">
            <span className="compare__title">{title}</span>
            {values.map((value, index) => (
                <span key={index} className="compare__col">
                    {value}
                    {levels && (
                        <span className="compare__levels">
                            {LEVELS.filter((level) => (levels[index][level] ?? 0) > 0).map((level) => (
                                <span key={level} style={{ '--c': levelColor(level) } as React.CSSProperties}>
                                    {level}×{levels[index][level]}
                                </span>
                            ))}
                        </span>
                    )}
                </span>
            ))}
        </div>
    );
    const closedOf = (part: number, count: number) => t('stats.closedOf', { part, count });
    const role = (value: (row: (typeof roles)[string]) => string) => ids.map((id) => value(roles[id]));

    return (
        <>
            <Title icon="i-stats-review">{t('stats.review.title')}</Title>
            <Card
                header={
                    <>
                        {t('stats.review.comments.title')}
                        <Segments options={dimensions()} value={prefs.commentsBy} onChange={(commentsBy) => update({ commentsBy })} />
                    </>
                }
                footer={t('stats.review.comments.footer')}
            >
                <DailyChart values={comments} series={commentSeries} range={stats.dayRange} unit={(value) => String(Math.round(value))} axisUnit={(value) => String(Math.round(value))} reviews={stats.reviewsPerDay()} />
            </Card>
            <Card
                header={
                    <>
                        {t('stats.review.fate.title')}
                        <Segments options={dimensions()} value={prefs.fateBy} onChange={(fateBy) => update({ fateBy })} />
                    </>
                }
                footer={t('stats.review.fate.footer')}
            >
                {fates.length ? <Rows>{fates.map((row) => <FateRow key={row.name} name={prefs.fateBy === 'agent' ? name(row.name) : row.name} agent={prefs.fateBy === 'agent' ? row.name : undefined} fate={row.fate} />)}</Rows> : <Empty />}
            </Card>

            <Title icon="i-stats-noise">{t('stats.noise.title')}</Title>
            <div className="kpi-row">
                <Kpi title={t('stats.noise.beforeRules')} value={percent(rules.before.dismissed, rules.before.addressed + rules.before.dismissed)} detail={rules.before.addressed + rules.before.dismissed > 0 ? closedOf(rules.before.dismissed, rules.before.addressed + rules.before.dismissed) : t('stats.noise.noClosed')} />
                <Kpi title={t('stats.noise.afterRules', { date: rulesDay() })} value={percent(rules.after.dismissed, rules.after.addressed + rules.after.dismissed)} detail={rules.after.addressed + rules.after.dismissed > 0 ? closedOf(rules.after.dismissed, rules.after.addressed + rules.after.dismissed) : t('stats.noClosedYet')} />
                <Kpi title={t('stats.noise.unpublished')} value={String(selection.backlogged + selection.filtered)} detail={t('stats.noise.unpublishedDetail', { backlogged: selection.backlogged, filtered: selection.filtered })} />
            </div>
            <Card
                header={t('stats.noise.weekly.title')}
                footer={t('stats.noise.weekly.footer', { date: rulesDate() })}
            >
                <NoiseChart weeks={stats.noiseWeeks()} start={weekOf(stats.periodStart)} end={stats.dayRange.end} />
            </Card>
            <Card
                header={t('stats.noise.selection.title')}
                footer={t('stats.noise.selection.footer', { date: rulesDate() })}
            >
                {selection.runs === 0 ? (
                    <Empty text={t('stats.noise.selection.empty')} />
                ) : (
                    <>
                        <Rows>
                            {(
                                [
                                    [t('stats.noise.selection.published'), selection.published, 'var(--fate-addressed)'],
                                    [t('stats.noise.selection.backlogged'), selection.backlogged, 'var(--fate-waiting)'],
                                    [t('stats.noise.selection.filtered'), selection.filtered, 'var(--level-p3)'],
                                    [t('stats.noise.selection.dropped'), selection.dropped, 'var(--fate-dismissed)'],
                                ] as [string, number, string][]
                            ).map(([title, count, c]) => (
                                <ShareRow key={title} title={title} value={String(count)} share={found > 0 ? count / found : 0} c={c} />
                            ))}
                        </Rows>
                        <div className="card-note" style={{ paddingBottom: 'var(--space-10)' }}>
                            {t('stats.noise.selection.total', { count: found, reviews: t('stats.reviews', { count: selection.runs }) })}
                        </div>
                    </>
                )}
            </Card>
            <Card
                header={
                    <>
                        {t('stats.noise.disagree.title')}
                        <span className="section__header-note">{reasons.checked > 0 ? t('stats.noise.disagree.note', { part: disagreed, count: reasons.checked }) : ''}</span>
                    </>
                }
                footer={t('stats.noise.disagree.footer', { date: rulesDate() })}
            >
                {disagreed === 0 ? (
                    <Empty />
                ) : (
                    <Rows>
                        {([...DISAGREE_REASONS, 'unknown'] as ReasonKey[])
                            .filter((key) => (reasons.reasons[key] ?? 0) > 0)
                            .map((key) => (
                                <ShareRow key={key} title={t(`stats.noise.disagree.reason.${key}`, { date: rulesDay() })} value={String(reasons.reasons[key])} share={reasons.reasons[key] / disagreed} c={REASON_COLORS[key]} />
                            ))}
                    </Rows>
                )}
            </Card>

            <Title icon="i-stats-quality">{t('stats.quality.title')}</Title>
            <div className="kpi-row">
                <Kpi title={t('stats.quality.findings')} value={String(stats.findingCount)} detail={t('stats.periodDays', { count: prefs.days })} />
                <Kpi title={t('stats.quality.addressed')} value={fateClosed(fate) > 0 ? `${Math.floor((fate.addressed * 100) / fateClosed(fate))}%` : '—'} detail={fateClosed(fate) > 0 ? closedOf(fate.addressed, fateClosed(fate)) : t('stats.noClosedYet')} />
                <Kpi title={t('stats.quality.dismissed')} value={fateClosed(fate) > 0 ? `${Math.floor((fate.dismissed * 100) / fateClosed(fate))}%` : '—'} detail={fateClosed(fate) > 0 ? t('stats.quality.dismissedDetail', { part: fate.dismissed, count: fateClosed(fate) }) : t('stats.noClosedYet')} />
            </div>
            <Card
                header={
                    <>
                        {t('stats.quality.density.title')}
                        <Segments options={dimensions().filter((item) => item.id !== 'agent').reverse() as { id: 'author' | 'repo'; title: string }[]} value={prefs.densityBy} onChange={(densityBy) => update({ densityBy })} />
                    </>
                }
                footer={t('stats.quality.density.footer')}
            >
                {density.length ? (
                    <>
                        <Rows>{density.map((row) => <DensityRow key={row.name} row={row} scale={Math.max(maxDensity, 0.1)} />)}</Rows>
                        <div className="legend legend--card">
                            {LEVELS.map((level) => (
                                <span key={level} className="legend__item">
                                    <Dot c={levelColor(level)} />
                                    {level}
                                </span>
                            ))}
                        </div>
                    </>
                ) : (
                    <Empty />
                )}
            </Card>

            <Title icon="i-stats-time">{t('stats.time.title')}</Title>
            <Card
                header={t('stats.time.median.title')}
                footer={t('stats.time.median.footer')}
            >
                {toFix.length ? <Rows>{toFix.map((row) => <ShareRow key={row.level} title={row.level} detail={t('stats.time.fixed', { count: row.count })} value={hours(row.median)} share={row.median / longest} c={levelColor(row.level)} />)}</Rows> : <Empty />}
            </Card>

            <Title icon="i-stats-compare">{t('stats.compare.title')}</Title>
            <Card footer={t('stats.compare.footer')}>
                <div className="compare__head">
                    <span className="compare__title" />
                    {ids.map((id) => (
                        <span key={id} className="compare__col">
                            <span className={`model-mark model--${id}`} />
                            {name(id)}
                        </span>
                    ))}
                </div>
                <div className="compare__group">{t('stats.compare.first')}</div>
                <Rows>{[compareRow(t('stats.compare.runs'), role((row) => String(row.firstRuns))), compareRow(t('stats.compare.findingsPerRun'), role((row) => perRun(row.firstFindings, row.firstRuns)), ids.map((id) => roles[id].firstFindings))]}</Rows>
                <div className="compare__group">{t('stats.compare.second')}</div>
                <Rows>{[compareRow(t('stats.compare.runs'), role((row) => String(row.secondRuns))), compareRow(t('stats.compare.newFindingsPerRun'), role((row) => perRun(row.secondFindings, row.secondRuns)), ids.map((id) => roles[id].secondFindings))]}</Rows>
                <div className="compare__group">{t('stats.compare.team')}</div>
                <Rows>
                    {[
                        compareRow(t('stats.compare.addressed'), ids.map((id) => share(id, 'addressed'))),
                        compareRow(t('stats.compare.ignored'), ids.map((id) => share(id, 'ignored'))),
                        compareRow(t('stats.compare.disputed'), ids.map((id) => share(id, 'disputed'))),
                        compareRow(t('stats.compare.waiting'), ids.map((id) => String(fateByAgent[id]?.waiting ?? 0))),
                    ]}
                </Rows>
                <div className="compare__group">{t('stats.compare.cross')}</div>
                <Rows>
                    {[
                        compareRow(t('stats.compare.confirmed'), role((row) => shareText(row.confirmed, row.confirmed + row.disputed))),
                        compareRow(t('stats.compare.agreed'), role((row) => given(row, row.agreed))),
                        compareRow(t('stats.compare.disagreed'), role((row) => given(row, row.disagreed))),
                        compareRow(t('stats.compare.skipped'), role((row) => given(row, row.skipped))),
                    ]}
                </Rows>
                <div className="compare__group">{t('stats.compare.price')}</div>
                <Rows>
                    {[
                        compareRow(t('stats.compare.timePerRun'), ids.map((id) => (costs[id]?.runs ? duration(Math.floor(costs[id].seconds / costs[id].runs)) : '—'))),
                        compareRow(t('stats.compare.tokensPerRun'), ids.map((id) => (costs[id]?.runs ? t('stats.thousands', { value: Math.floor(costs[id].tokens / costs[id].runs / 1000) }) : '—'))),
                        compareRow(t('stats.compare.costPerRun'), ids.map((id) => money(costs[id]?.pricedRuns ? costs[id].cost / costs[id].pricedRuns : null))),
                        compareRow(
                            t('stats.compare.costPerFix'),
                            ids.map((id) => {
                                const addressed = stats.pricedAddressed(id);
                                return costs[id]?.pricedRuns && addressed > 0 ? money(costs[id].cost / addressed) : '—';
                            }),
                        ),
                    ]}
                </Rows>
            </Card>

            <Title icon="i-stats-cost">{t('stats.cost.title')}</Title>
            <div className="kpi-row">
                <Kpi title={t('stats.cost.spent')} value={money(stats.totalSpend)} detail={t('stats.cost.spentDetail', { count: stats.spendings.length })} />
                <Kpi title={t('stats.cost.perPr')} value={prSpend.prs > 0 ? money(prSpend.cost / prSpend.prs) : '—'} detail={t('stats.cost.perPrDetail', { count: prSpend.prs })} />
                <Kpi title={t('stats.cost.perFix')} value={pricedAddressed > 0 ? money(stats.totalCost / pricedAddressed) : '—'} detail={t('stats.cost.perFixDetail', { count: fate.addressed })} />
            </div>
            <Card
                header={t('stats.cost.byKind.title')}
                footer={t('stats.cost.byKind.footer', { date: rulesDate() })}
            >
                {kinds.length ? (
                    <Rows>
                        {kinds.map((kind) => (
                            <ShareRow key={kind} title={workTitle(kind)} detail={t('stats.cost.byKind.runs', { count: byKind[kind]!.runs })} value={money(byKind[kind]!.cost)} share={stats.totalSpend > 0 ? byKind[kind]!.cost / stats.totalSpend : 0} c={seriesColor(WORK_KINDS.indexOf(kind))} />
                        ))}
                    </Rows>
                ) : (
                    <Empty />
                )}
            </Card>
            <Card header={t('stats.cost.perDay.title')} footer={t('stats.cost.perDay.footer')}>
                <DailyChart values={stats.spendPerDay()} series={kindSeries} range={stats.dayRange} unit={(value) => `$${value.toFixed(2)}`} axisUnit={(value) => `$${Math.round(value)}`} />
            </Card>

            <Title icon="i-fix">{t('stats.autofix.title')}</Title>
            <div className="kpi-row">
                <Kpi title={t('stats.autofix.runs')} value={String(stats.fixes.length)} detail={t('stats.autofix.runsDetail', { fix: t('stats.autofix.runsDetailFix', { count: stats.fixRuns.length }), rebase: t('stats.autofix.runsDetailRebase', { count: rebases }) })} />
                <Kpi title={t('stats.autofix.fixed')} value={String(stats.fixedCount)} detail={stats.fixSkipped > 0 ? t('stats.autofix.skippedDetail', { count: stats.fixSkipped }) : t('stats.periodDays', { count: prefs.days })} />
                <Kpi title={t('stats.autofix.costPerFix')} value={stats.fixedCount > 0 ? money(stats.fixCost / stats.fixedCount) : '—'} detail={t('stats.autofix.costDetail', { cost: money(stats.fixCost) })} />
            </div>
            <Card
                header={t('stats.autofix.outcomes.title')}
                footer={t('stats.autofix.outcomes.footer')}
            >
                {statuses.length ? (
                    <Rows>
                        {statuses.map(({ status, count }) => {
                            const known = FIX_STATUSES[status];
                            const [title, c] = known ? [t(known[0]), known[1]] : [status, 'var(--level-p3)'];
                            return <ShareRow key={status} title={title} value={String(count)} share={count / stats.fixes.length} c={c} />;
                        })}
                    </Rows>
                ) : (
                    <Empty />
                )}
            </Card>

            <Title icon="i-stats-modes">{t('stats.modes.title')}</Title>
            <div className="cards-2">
                <Card header={t('stats.modes.arch.title')}>
                    <Rows>{[<StatLine key="runs" title={t('stats.modes.arch.runs')} value={String(stats.archs.length)} />, ...VERDICTS.map(([id, c]) => <StatLine key={id} title={t(`stats.modes.arch.${id}`)} value={String(verdicts[id] ?? 0)} c={c} />)]}</Rows>
                </Card>
                <Card header={t('stats.modes.qa.title')}>
                    <Rows>
                        {[
                            <StatLine key="plans" title={t('stats.modes.qa.plans')} value={plans.length ? t('stats.modes.qa.plansValue', { plans: plans.length, count: plans.reduce((total, plan) => total + (typeof plan.cases === 'number' ? plan.cases : 0), 0) }) : '0'} />,
                            <StatLine key="runs" title={t('stats.modes.qa.runs')} value={String(runs.length)} />,
                            ...QA_STATUSES.filter(([id]) => (caseCounts[id] ?? 0) > 0).map(([id, c]) => <StatLine key={id} title={t(`stats.modes.qa.status.${id}`)} value={String(caseCounts[id])} c={c} />),
                            <StatLine key="bugs" title={t('stats.modes.qa.bugs')} value={String(runs.reduce((total, run) => total + (run.bugs ?? 0), 0))} />,
                        ]}
                    </Rows>
                </Card>
            </div>
            <div className="cards-2">
                <Card header={t('stats.modes.backlog.title')}>
                    <Rows>
                        {[
                            <StatLine key="found" title={t('stats.modes.backlog.found')} value={String(backlog.length)} />,
                            <StatLine key="filed" title={t('stats.modes.backlog.filed')} value={String(backlog.filter((item) => item.status === 'filed').length)} c="var(--fate-addressed)" />,
                            <StatLine key="dropped" title={t('stats.modes.backlog.dropped')} value={String(backlog.filter((item) => item.status === 'dropped').length)} c="var(--fate-dismissed)" />,
                            <StatLine key="open" title={t('stats.modes.backlog.open')} value={String(backlog.filter((item) => item.status === 'open').length)} c="var(--fate-waiting)" />,
                        ]}
                    </Rows>
                </Card>
                <Card header={t('stats.modes.memory.title')}>
                    <Rows>
                        {[
                            <StatLine key="rules" title={t('stats.modes.memory.rules')} value={String(memory.rules)} />,
                            <StatLine key="applied" title={t('stats.modes.memory.applied')} value={memory.runs > 0 ? decimal(memory.applied / memory.runs) : '—'} />,
                            <StatLine key="idle" title={t('stats.modes.memory.idle')} value={memory.idle != null ? String(memory.idle) : t('stats.modes.memory.notStarted')} />,
                        ]}
                    </Rows>
                    {memory.since && (
                        <div className="card-note">
                            {t('stats.modes.memory.since', { date: dayFull(memory.since) })}
                        </div>
                    )}
                </Card>
            </div>
            <div className="stats-footnote">
                {t('stats.modes.footnote', { date: rulesDate() })}
            </div>

            <Title icon="i-stats-savings">{t('stats.savings.title')}</Title>
            <div className="kpi-row">
                <Kpi title={t('stats.savings.skipped')} value={String(stats.skips.length)} detail={t('stats.savings.skippedDetail', { cost: money(stats.savedBySkips()) })} />
                <Kpi title={t('stats.savings.excluded')} value={t('stats.savings.excludedValue', { value: Math.floor(stats.excludedTokens / 1000) })} detail={t('stats.savings.excludedDetail', { cost: money(stats.excludedCost(costs)) })} />
            </div>
            <div className="stats-footnote">{t('stats.savings.footnote')}</div>
        </>
    );
};

