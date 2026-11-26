import { CheckMenuItem, Menu, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApiClient } from '../api/client';
import { Icon } from '../components/Icon';
import { agentIds, agentName } from '../model/derive';
import type { Data } from '../model/types';
import { DailyChart, NoiseChart, type Series } from './Charts';
import {
    DISAGREE_REASONS,
    LEVELS,
    WORK_KINDS,
    WORK_TITLES,
    fateClosed,
    fateIgnored,
    roleStats,
    statsData,
    weekOf,
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
import { decimal, duration, hours, money, percent, shareText } from './format';
import { loadStatsPrefs, saveStatsPrefs, type Dimension, type StatsPrefs } from './prefs';
import { Card, DensityRow, Dot, Empty, FateRow, Kpi, Rows, Segments, ShareRow, StatLine, Title, levelColor } from './rows';
import { exportImage } from './exportImage';

type Journals = Pick<StatsInput, 'stats' | 'outcomes' | 'skips' | 'spend' | 'fixLog' | 'archLog' | 'qaLog' | 'backlog'>;

const PASSES = [
    { id: 'initial', title: 'Первое ревью' },
    { id: 'followup', title: 'После правок' },
    { id: 'replies', title: 'Ответы в тредах' },
];
const DIMENSIONS: { id: Dimension; title: string }[] = [
    { id: 'agent', title: 'Модели' },
    { id: 'repo', title: 'Репозитории' },
    { id: 'author', title: 'Авторы' },
];
// Цвет репозитория и автора — по месту в стабильном отсортированном списке, а не в отфильтрованном
const seriesColor = (index: number) => `var(--chart-${(index % 8) + 1})`;

const FIX_STATUSES: Record<string, [string, string]> = {
    pushed: ['Запушено', 'var(--fate-addressed)'],
    nothing: ['Нечего менять', 'var(--level-p3)'],
    'commit-failed': ['Не удалось закоммитить', 'var(--fate-dismissed)'],
    'checks-failed': ['Не прошли проверки', 'var(--level-p2)'],
    'rebase-failed': ['Rebase не удался', 'var(--level-p0)'],
    'push-rejected': ['Push отклонён', 'var(--level-p1)'],
};
const REASONS: Record<string, [string, string]> = {
    wrong: ['Утверждение о коде неверно', 'var(--level-p0)'],
    fixed: ['Уже исправлено в ветке', 'var(--fate-addressed)'],
    preexisting: ['Было до PR — в бэклог', 'var(--fate-waiting)'],
    unlikely: ['Редкий сценарий, лёгкое последствие', 'var(--level-p2)'],
    unknown: ['Причина не указана (до 19.10)', 'var(--level-p3)'],
};
const VERDICTS: [string, string, string][] = [
    ['keep', 'Оставить как есть', 'var(--green)'],
    ['discuss', 'Стоит обсудить', 'var(--yellow)'],
    ['rework', 'Лучше переделать', 'var(--orange)'],
];
const QA_STATUSES: [string, string, string][] = [
    ['failed', 'Ошибка приложения', 'var(--red)'],
    ['unconfirmed', 'Не подтверждено', 'var(--yellow)'],
    ['blocked', 'Не удалось проверить', 'var(--orange)'],
    ['passed', 'Прошёл', 'var(--green)'],
    ['skipped', 'Пропущен', 'var(--gray)'],
];
const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

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
        [journals, data.config, data.state, data.memory, prefs],
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
                <Filter icon="i-repo" allTitle="Все репозитории" options={data.config.repos.map((repo) => ({ id: repo.slug, title: repo.slug }))} value={prefs.repo} onChange={(repo) => update({ repo })} />
                <Filter icon="i-person" allTitle="Все авторы" options={authors.map((author) => ({ id: author, title: author }))} value={prefs.author} onChange={(author) => update({ author })} />
                <Filter icon="i-model" allTitle="Все модели" options={ids.map((id) => ({ id, title: agentName(data.config, id) }))} value={prefs.agent} onChange={(agent) => update({ agent })} />
                <Filter icon="i-pass" allTitle="Любое ревью" options={PASSES} value={prefs.pass} onChange={(pass) => update({ pass })} />
                <span className="spacer" />
                <div className="segmented segmented--compact">
                    {[7, 30, 90].map((days) => (
                        <button key={days} className="segmented__item" aria-selected={prefs.days === days} onClick={() => update({ days })}>
                            {days} дн.
                        </button>
                    ))}
                </div>
                <button className="square-button" title="Сохранить всю статистику картинкой в «Загрузки»" disabled={!stats || saving} onClick={save}>
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
    const comments = stats.commentsPerDay((entry) => (prefs.commentsBy === 'agent' ? name(entry.agent) : prefs.commentsBy === 'repo' ? entry.repo : (entry.author ?? 'неизвестно')));
    const fates = stats.fate((repo, author, agent) => (prefs.fateBy === 'agent' ? agent : prefs.fateBy === 'repo' ? (repo ?? 'неизвестно') : (author ?? 'неизвестно')));

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
    const kindSeries: Series[] = WORK_KINDS.map((kind, index) => ({ name: WORK_TITLES[kind], color: seriesColor(index) }));

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
    const role = (value: (row: (typeof roles)[string]) => string) => ids.map((id) => value(roles[id]));

    return (
        <>
            <Title icon="i-stats-review">Ревью</Title>
            <Card
                header={
                    <>
                        Комментарии ревьюеров по дням
                        <Segments options={DIMENSIONS} value={prefs.commentsBy} onChange={(commentsBy) => update({ commentsBy })} />
                    </>
                }
                footer="Опубликованные замечания и ответы на чужие треды, без «пропусков». Над днём — сколько было ревью кода (за 90 дней — в подсказке). Наведите на столбец, чтобы увидеть значения."
            >
                <DailyChart values={comments} series={commentSeries} range={stats.dayRange} unit={(value) => String(Math.round(value))} axisUnit={(value) => String(Math.round(value))} reviews={stats.reviewsPerDay()} />
            </Card>
            <Card
                header={
                    <>
                        Судьба замечаний
                        <Segments options={DIMENSIONS} value={prefs.fateBy} onChange={(fateBy) => update({ fateBy })} />
                    </>
                }
                footer="«Исправлено» — автор правил код в пределах двух строк от замечания. «Отклонено» — код рядом не меняли, а тред закрыли через Resolve или PR влили: команда решила не править. «Ждут правки» — открытые треды в открытых PR сейчас, без учёта периода."
            >
                {fates.length ? <Rows>{fates.map((row) => <FateRow key={row.name} name={prefs.fateBy === 'agent' ? name(row.name) : row.name} agent={prefs.fateBy === 'agent' ? row.name : undefined} fate={row.fate} />)}</Rows> : <Empty />}
            </Card>

            <Title icon="i-stats-noise">Шум</Title>
            <div className="kpi-row">
                <Kpi title="Отклонено до новых правил" value={percent(rules.before.dismissed, rules.before.addressed + rules.before.dismissed)} detail={rules.before.addressed + rules.before.dismissed > 0 ? `${rules.before.dismissed} из ${rules.before.addressed + rules.before.dismissed} закрытых` : 'закрытых нет'} />
                <Kpi title="Отклонено после 19.10" value={percent(rules.after.dismissed, rules.after.addressed + rules.after.dismissed)} detail={rules.after.addressed + rules.after.dismissed > 0 ? `${rules.after.dismissed} из ${rules.after.addressed + rules.after.dismissed} закрытых` : 'закрытых пока нет'} />
                <Kpi title="Не опубликовано" value={String(selection.backlogged + selection.filtered)} detail={`в бэклог ${selection.backlogged} · редких P3 ${selection.filtered}`} />
            </div>
            <Card
                header="Доля отклонённых по неделям"
                footer="Сколько замечаний закрыли без правки кода, из закрытых, — по неделе публикации замечания. Над столбцом — отклонено из закрытых. Линия — 19.10.2026, новые правила отбора: баги, которые были до PR, уходят в бэклог, редкие P3 не публикуются. Плитки «до» и «после» делятся по первому ревью с новыми правилами. Последние недели неполные: часть замечаний ещё ждёт правки."
            >
                <NoiseChart weeks={stats.noiseWeeks()} start={weekOf(stats.periodStart)} end={stats.dayRange.end} />
            </Card>
            <Card
                header="Отбор замечаний"
                footer="По ревью с новыми правилами (с 19.10.2026): что модели нашли и что из этого ушло в PR. «В бэклог» — проблема была до PR, по ней заводят отдельную задачу. «Редкие P3» — редкий сценарий или гонка с лёгким последствием. «Нет в диффе» — замечание к файлу, в котором PR не меняет ни строки; такие не публикуются."
            >
                {selection.runs === 0 ? (
                    <Empty text="Ревью по новым правилам за период ещё не было" />
                ) : (
                    <>
                        <Rows>
                            {(
                                [
                                    ['Опубликовано', selection.published, 'var(--fate-addressed)'],
                                    ['В бэклог', selection.backlogged, 'var(--fate-waiting)'],
                                    ['Редкие P3', selection.filtered, 'var(--level-p3)'],
                                    ['Нет в диффе', selection.dropped, 'var(--fate-dismissed)'],
                                ] as [string, number, string][]
                            ).map(([title, count, c]) => (
                                <ShareRow key={title} title={title} value={String(count)} share={found > 0 ? count / found : 0} c={c} />
                            ))}
                        </Rows>
                        <div className="card-note" style={{ paddingBottom: 'var(--space-10)' }}>
                            {found} находок в {selection.runs} ревью
                        </div>
                    </>
                )}
            </Card>
            <Card
                header={
                    <>
                        Почему модели не согласны
                        <span className="section__header-note">{reasons.checked > 0 ? `оспорено ${disagreed} из ${reasons.checked} проверенных` : ''}</span>
                    </>
                }
                footer="Ответы моделей на чужие замечания: почему проверяющая модель не согласна. Причину модели указывают с 19.10.2026. «Было до PR» уходит в бэклог, «Редкий сценарий» — тот же отбор, что у своих замечаний."
            >
                {disagreed === 0 ? (
                    <Empty />
                ) : (
                    <Rows>
                        {[...DISAGREE_REASONS, 'unknown']
                            .filter((key) => (reasons.reasons[key] ?? 0) > 0)
                            .map((key) => (
                                <ShareRow key={key} title={REASONS[key][0]} value={String(reasons.reasons[key])} share={reasons.reasons[key] / disagreed} c={REASONS[key][1]} />
                            ))}
                    </Rows>
                )}
            </Card>

            <Title icon="i-stats-quality">Качество кода</Title>
            <div className="kpi-row">
                <Kpi title="Замечаний" value={String(stats.findingCount)} detail={`за ${prefs.days} дн.`} />
                <Kpi title="Исправлено" value={fateClosed(fate) > 0 ? `${Math.floor((fate.addressed * 100) / fateClosed(fate))}%` : '—'} detail={fateClosed(fate) > 0 ? `${fate.addressed} из ${fateClosed(fate)} закрытых` : 'закрытых пока нет'} />
                <Kpi title="Отклонено" value={fateClosed(fate) > 0 ? `${Math.floor((fate.dismissed * 100) / fateClosed(fate))}%` : '—'} detail={fateClosed(fate) > 0 ? `${fate.dismissed} из ${fateClosed(fate)} — не стали править` : 'закрытых пока нет'} />
            </div>
            <Card
                header={
                    <>
                        Замечаний на 1000 строк
                        <Segments options={DIMENSIONS.filter((item) => item.id !== 'agent').reverse() as { id: 'author' | 'repo'; title: string }[]} value={prefs.densityBy} onChange={(densityBy) => update({ densityBy })} />
                    </>
                }
                footer="Замечаний всех моделей на 1000 изменённых строк, без исключённых файлов. Сравнивать по числу замечаний нечестно: больше всех «ошибается» тот, кто больше пишет. Меньше 500 строк — мало данных, такие строки приглушены и стоят в конце."
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

            <Title icon="i-stats-time">Время до исправления</Title>
            <Card
                header="Медиана по уровням"
                footer="Медиана часов от публикации замечания до правки кода рядом с ним — по исправленным замечаниям, закрытым за период. Медиана, а не среднее: одно замечание, пролежавшее неделю, не перекашивает картину."
            >
                {toFix.length ? <Rows>{toFix.map((row) => <ShareRow key={row.level} title={row.level} detail={`${row.count} исправлено`} value={hours(row.median)} share={row.median / longest} c={levelColor(row.level)} />)}</Rows> : <Empty />}
            </Card>

            <Title icon="i-stats-compare">Сравнение моделей</Title>
            <Card footer="Первым — модель ревьюит новый коммит с чистого листа; вторым — видит замечания первой, проверяет их и добавляет свои. Порядок чередуется на каждом новом коммите.">
                <div className="compare__head">
                    <span className="compare__title" />
                    {ids.map((id) => (
                        <span key={id} className="compare__col">
                            <span className={`model-mark model--${id}`} />
                            {name(id)}
                        </span>
                    ))}
                </div>
                <div className="compare__group">Ревью первым</div>
                <Rows>{[compareRow('Ревью', role((row) => String(row.firstRuns))), compareRow('Замечаний на ревью', role((row) => perRun(row.firstFindings, row.firstRuns)), ids.map((id) => roles[id].firstFindings))]}</Rows>
                <div className="compare__group">Ревью вторым</div>
                <Rows>{[compareRow('Ревью', role((row) => String(row.secondRuns))), compareRow('Новых замечаний на ревью', role((row) => perRun(row.secondFindings, row.secondRuns)), ids.map((id) => roles[id].secondFindings))]}</Rows>
                <div className="compare__group">Реакция команды</div>
                <Rows>
                    {[
                        compareRow('Исправили', ids.map((id) => share(id, 'addressed'))),
                        compareRow('Не стали править молча', ids.map((id) => share(id, 'ignored'))),
                        compareRow('Оспорили в треде', ids.map((id) => share(id, 'disputed'))),
                        compareRow('Ждут правки', ids.map((id) => String(fateByAgent[id]?.waiting ?? 0))),
                    ]}
                </Rows>
                <div className="compare__group">Перекрёстная проверка</div>
                <Rows>
                    {[
                        compareRow('Подтверждение другой моделью', role((row) => shareText(row.confirmed, row.confirmed + row.disputed))),
                        compareRow('Согласился с чужими', role((row) => given(row, row.agreed))),
                        compareRow('Оспорил чужие', role((row) => given(row, row.disagreed))),
                        compareRow('Пропустил (не утверждение о коде)', role((row) => given(row, row.skipped))),
                    ]}
                </Rows>
                <div className="compare__group">Цена и время</div>
                <Rows>
                    {[
                        compareRow('Время на запуск', ids.map((id) => (costs[id]?.runs ? duration(Math.floor(costs[id].seconds / costs[id].runs)) : '—'))),
                        compareRow('Токенов на запуск', ids.map((id) => (costs[id]?.runs ? `${Math.floor(costs[id].tokens / costs[id].runs / 1000)} тыс.` : '—'))),
                        compareRow('Цена запуска', ids.map((id) => money(costs[id]?.pricedRuns ? costs[id].cost / costs[id].pricedRuns : null))),
                        compareRow(
                            'Цена исправленного замечания',
                            ids.map((id) => {
                                const addressed = stats.pricedAddressed(id);
                                return costs[id]?.pricedRuns && addressed > 0 ? money(costs[id].cost / addressed) : '—';
                            }),
                        ),
                    ]}
                </Rows>
            </Card>

            <Title icon="i-stats-cost">Стоимость</Title>
            <div className="kpi-row">
                <Kpi title="Потрачено" value={money(stats.totalSpend)} detail={`${stats.spendings.length} запусков моделей`} />
                <Kpi title="За PR" value={prSpend.prs > 0 ? money(prSpend.cost / prSpend.prs) : '—'} detail={`${prSpend.prs} PR, всё, что делали по PR`} />
                <Kpi title="За исправленное замечание" value={pricedAddressed > 0 ? money(stats.totalCost / pricedAddressed) : '—'} detail={`цена ревью · ${fate.addressed} исправлено`} />
            </div>
            <Card
                header="По видам работы"
                footer="Цена по тарифам API: Claude сообщает её сам, для Codex и Cursor она считается по токенам и тарифам из config.json — agents.<модель>.modelPricing для выбранной модели или agents.<модель>.pricing. С токеном подписки это не реальное списание. Траты памяти и бэклога до 19.10.2026 перенесены из лога с точностью до цента. Фильтр автора действует на всё, что привязано к PR, фильтр типа ревью — только на ревью и ответы в тредах."
            >
                {kinds.length ? (
                    <Rows>
                        {kinds.map((kind) => (
                            <ShareRow key={kind} title={WORK_TITLES[kind]} detail={`${byKind[kind]!.runs} запусков`} value={money(byKind[kind]!.cost)} share={stats.totalSpend > 0 ? byKind[kind]!.cost / stats.totalSpend : 0} c={seriesColor(WORK_KINDS.indexOf(kind))} />
                        ))}
                    </Rows>
                ) : (
                    <Empty />
                )}
            </Card>
            <Card header="Траты по дням" footer="Все виды работы, той же раскраской. «За PR» — ревью, ответы, автофикс, rebase, архитектура и тестирование, поделённые на число PR; память и бэклог к PR не привязаны и в эту цену не входят.">
                <DailyChart values={stats.spendPerDay()} series={kindSeries} range={stats.dayRange} unit={(value) => `$${value.toFixed(2)}`} axisUnit={(value) => `$${Math.round(value)}`} />
            </Card>

            <Title icon="i-fix">Автофикс</Title>
            <div className="kpi-row">
                <Kpi title="Запусков" value={String(stats.fixes.length)} detail={`${stats.fixRuns.length} автофикс · ${rebases} rebase`} />
                <Kpi title="Исправлено замечаний" value={String(stats.fixedCount)} detail={stats.fixSkipped > 0 ? `ещё ${stats.fixSkipped} модель пропустила` : `за ${prefs.days} дн.`} />
                <Kpi title="Цена исправленного" value={stats.fixedCount > 0 ? money(stats.fixCost / stats.fixedCount) : '—'} detail={`${money(stats.fixCost)} на автофикс`} />
            </div>
            <Card
                header="Исходы запусков"
                footer="«Запушено» — правка или rebase в ветке PR. «Нечего менять» — модель не нашла, что править. Остальное — запуск не дошёл до ветки: коммит, проверки, конфликт rebase или push, отклонённый из-за новых коммитов. Цена исправленного — траты автофикса без rebase на исправленные им замечания."
            >
                {statuses.length ? (
                    <Rows>
                        {statuses.map(({ status, count }) => {
                            const [title, c] = FIX_STATUSES[status] ?? [status, 'var(--level-p3)'];
                            return <ShareRow key={status} title={title} value={String(count)} share={count / stats.fixes.length} c={c} />;
                        })}
                    </Rows>
                ) : (
                    <Empty />
                )}
            </Card>

            <Title icon="i-stats-modes">Новые режимы</Title>
            <div className="cards-2">
                <Card header="Архитектурное ревью">
                    <Rows>{[<StatLine key="runs" title="Запусков" value={String(stats.archs.length)} />, ...VERDICTS.map(([id, title, c]) => <StatLine key={id} title={title} value={String(verdicts[id] ?? 0)} c={c} />)]}</Rows>
                </Card>
                <Card header="Тестирование">
                    <Rows>
                        {[
                            <StatLine key="plans" title="Планов" value={plans.length ? `${plans.length} · ${plans.reduce((total, plan) => total + (typeof plan.cases === 'number' ? plan.cases : 0), 0)} кейсов` : '0'} />,
                            <StatLine key="runs" title="Прогонов" value={String(runs.length)} />,
                            ...QA_STATUSES.filter(([id]) => (caseCounts[id] ?? 0) > 0).map(([id, title, c]) => <StatLine key={id} title={title} value={String(caseCounts[id])} c={c} />),
                            <StatLine key="bugs" title="Найдено багов" value={String(runs.reduce((total, run) => total + (run.bugs ?? 0), 0))} />,
                        ]}
                    </Rows>
                </Card>
            </div>
            <div className="cards-2">
                <Card header="Бэклог">
                    <Rows>
                        {[
                            <StatLine key="found" title="Найдено проблем" value={String(backlog.length)} />,
                            <StatLine key="filed" title="Заведено задач" value={String(backlog.filter((item) => item.status === 'filed').length)} c="var(--fate-addressed)" />,
                            <StatLine key="dropped" title="Отклонено" value={String(backlog.filter((item) => item.status === 'dropped').length)} c="var(--fate-dismissed)" />,
                            <StatLine key="open" title="Ждут разбора" value={String(backlog.filter((item) => item.status === 'open').length)} c="var(--fate-waiting)" />,
                        ]}
                    </Rows>
                </Card>
                <Card header="Память ревьюеров">
                    <Rows>
                        {[
                            <StatLine key="rules" title="Правил" value={String(memory.rules)} />,
                            <StatLine key="applied" title="Срабатываний за ревью" value={memory.runs > 0 ? decimal(memory.applied / memory.runs) : '—'} />,
                            <StatLine key="idle" title="Ни разу не сработали" value={memory.idle != null ? String(memory.idle) : 'учёт не начат'} />,
                        ]}
                    </Rows>
                    {memory.since && (
                        <div className="card-note">
                            учёт с {memory.since.getDate()} {MONTHS_GENITIVE[memory.since.getMonth()]}
                        </div>
                    )}
                </Card>
            </div>
            <div className="stats-footnote">
                Архитектура и тестирование — запуски за период. Бэклог — проблемы вне PR, найденные за период, и что с ними сейчас; фильтр модели — по модели, которая их нашла. Память — правила сейчас; срабатывания — в среднем на ревью за период (модели отмечают сработавшие правила с 19.10.2026); «ни разу не сработали» — с начала учёта, без учёта периода и фильтра модели.
            </div>

            <Title icon="i-stats-savings">Экономия</Title>
            <div className="kpi-row">
                <Kpi title="Пропущено раундов" value={String(stats.skips.length)} detail={`≈ ${money(stats.savedBySkips())} сэкономлено`} />
                <Kpi title="Вырезано из диффов" value={`≈ ${Math.floor(stats.excludedTokens / 1000)} тыс.`} detail={`токенов, ≈ ${money(stats.excludedCost(costs))}`} />
            </div>
            <div className="stats-footnote">Раунд пропускается, когда после rebase изменения PR те же или изменились только исключённые файлы; его цена — средняя цена ревью этой модели. Вырезанные токены — оценка по размеру исключённой части диффа, по 4 байта на токен.</div>
        </>
    );
};

