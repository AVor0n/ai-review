import { invoke } from '@tauri-apps/api/core';
import { confirm } from '../dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { errorText, type ApiClient } from '../api/client';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { Steps, stepDuration, type Step } from '../components/Steps';
import { t } from '../i18n';
import { ago, formatDate, parse } from '../model/format';
import { middle } from '../model/middle';
import type { Data } from '../model/types';
import { fileName, isMedia, isVideo, thumbUrl, viewerQuery } from './media';

// Лист «Тестирование PR» — перенос QaSheet и QaText из menubar/QaViews.swift.
// Разметка — шаблоны tpl-qa-*, tpl-sheet-* и tpl-report-body макета 2026-11-26-tauri-qa.html
type Case = {
    id: string;
    title: string;
    source: string;
    priority: string;
    level?: string | null;
    target?: string | null;
    preconditions?: string | null;
    steps: string[];
    expect?: string | null;
    status?: string | null;
    claimed?: string | null;
    checked?: string | null;
    notes?: string | null;
    bug?: { title: string; details: string } | null;
    evidence?: { status: string; files: string[]; errors: string[]; specFile?: string | null } | null;
    savePath?: string | null;
};
type Plan = { kind: string; testable: boolean; summary: string; expected: string; risks: { title: string; details: string; path?: string | null }[]; cases: Case[]; notTestable: { what: string; why: string }[] };
type Run = {
    head: string;
    branch?: string | null;
    planHead?: string | null;
    backend?: { ref: string; commit: string } | null;
    summary: string;
    envNotes?: string | null;
    runDir: string;
    usage?: { costUsd?: number | null } | null;
    durationSec?: number | null;
    cases: Case[];
    tests?: { source: string; file: string; target: string; level?: string | null; cases: string[] }[] | null;
    saved?: { at: string; checkout: string; branch?: string | null; prBranch?: string | null; files: { path: string; wanted: string; cases: string[] }[] } | null;
};
type Qa = {
    state: string;
    step?: string | null;
    steps?: Step[] | null;
    activity?: string | null;
    error?: string | null;
    note?: string | null;
    planHead?: string | null;
    plan?: Plan | null;
    run?: Run | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    usage?: { costUsd?: number | null } | null;
};
type Tab = 'plan' | 'report';

const isWindows = navigator.userAgent.includes('Windows');
const ACTIVE = ['planning-queued', 'planning', 'run-queued', 'running'];
const PATH_CHARS = 84;
const STATUS_ORDER = ['failed', 'unconfirmed', 'blocked', 'passed', 'skipped'];
type Status = 'passed' | 'failed' | 'blocked' | 'skipped' | 'unconfirmed';
const STATUS: Record<Status, [string, string]> = {
    passed: ['i-check-circle-fill', 'var(--green)'],
    failed: ['i-qa-failed', 'var(--red)'],
    blocked: ['i-qa-blocked', 'var(--orange)'],
    skipped: ['i-minus-circle-fill', 'var(--gray)'],
    unconfirmed: ['i-qa-unconfirmed', 'var(--yellow)'],
};
const statusKey = (value: string | null | undefined): Status => (value && value in STATUS ? (value as Status) : 'unconfirmed');
const status = (value: string | null | undefined): [string, string, string] => {
    const key = statusKey(value);
    return [t(`qa.status.${key}`), ...STATUS[key]];
};
const kind = (value: string) => (value === 'bug' || value === 'feature' || value === 'refactor' ? t(`qa.kind.${value}`) : t('qa.kind.unknown'));
const source = (value: string): [string, string] =>
    value === 'user' ? [t('qa.source.user'), 'tag--accent'] : value === 'change' || value === 'regression' ? [t(`qa.source.${value}`), ''] : [value, ''];
const priority = (value: string): [string, string] => (value === 'high' ? [t('qa.priority.high'), 'tag--orange'] : value === 'medium' ? [t('qa.priority.medium'), ''] : [t('qa.priority.low'), '']);
const levelKey = (value: string | null | undefined) => (value === 'unit' || value === 'component' ? value : 'e2e');
const level = (value: string | null | undefined) => t(`qa.level.${levelKey(value)}`);
const playwright = (value: string) => (value === 'passed' || value === 'failed' || value === 'timedOut' || value === 'skipped' ? t(`qa.playwright.${value}`) : value);
const cases = (count: number) => t('qa.cases', { count });
const money = (value: number) => `$${value.toFixed(2)}`;
const tone = (color: string) => ({ '--c': color }) as CSSProperties;
const count = (run: Run, value: string) => run.cases.filter((item) => item.status === value).length;
// Итог прогона одним цветом: ошибка приложения важнее неподтверждённых и заблокированных кейсов
const runColor = (run: Run) => (count(run, 'failed') > 0 ? 'var(--red)' : count(run, 'unconfirmed') + count(run, 'blocked') > 0 ? 'var(--orange)' : 'var(--green)');
// Голова в состоянии — первые 12 символов коммита, в снимке PR длину не закладываем
const sameCommit = (a: string | null | undefined, b: string) => !a || !b || a.startsWith(b) || b.startsWith(a);
const exactDate = (iso: string | null | undefined) => {
    const date = parse(iso);
    return date ? formatDate(date, { dateStyle: 'medium', timeStyle: 'short' }) : null;
};

const Section = ({ title, footer, children }: { title: string; footer?: string | null; children: ReactNode }) => (
    <div className="section">
        <div className="section__header">{title}</div>
        <div className="section__card">{children}</div>
        {footer && <div className="section__footer">{footer}</div>}
    </div>
);

const Rows = ({ items, divider = 'row-divider row-divider--marker', style }: { items: ReactNode[]; divider?: string; style?: CSSProperties }) => (
    <>
        {items.map((item, index) => (
            <div key={index}>
                {index > 0 && <div className={divider} style={style} />}
                {item}
            </div>
        ))}
    </>
);

const Details = ({ rows }: { rows: [string, string | null | undefined][] }) => {
    const shown = rows.filter(([, value]) => value) as [string, string][];
    return (
        <Section title={t('qa.report.details')}>
            <Rows
                divider="row-divider"
                items={shown.map(([title, value]) => (
                    <div key={title} className="detail-row">
                        <span className="detail-row__title">{title}</span>
                        <span className="detail-row__value selectable">{value}</span>
                    </div>
                ))}
            />
        </Section>
    );
};

const Banner = ({ icon = 'i-history', title, text }: { icon?: string; title: string; text: string }) => (
    <div className="banner banner--warning">
        <Icon id={icon} className="icon banner__icon" />
        <div className="banner__body">
            <div className="banner__title">{title}</div>
            <div className="banner__text">{text}</div>
        </div>
    </div>
);

// Ошибку сервиса показываем целиком, как он её написал: в ней обычно и причина, и что сделать
const ErrorBox = ({ text }: { text: string }) => (
    <div className="banner banner--alert">
        <Icon id="i-warning-fill" className="icon banner__icon" />
        <div className={`banner__message selectable${text.includes('\n') ? ' banner__message--mono' : ''}`}>{text.trim()}</div>
    </div>
);

const Tags = ({ item }: { item: Case }) => {
    const [sourceTitle, sourceClass] = source(item.source);
    const [priorityTitle, priorityClass] = priority(item.priority);
    return (
        <span className="tags">
            <span className="tag tag--indigo">{level(item.level)}</span>
            <span className={`tag ${sourceClass}`}>{sourceTitle}</span>
            <span className={`tag ${priorityClass}`}>{priorityTitle}</span>
        </span>
    );
};

const Labeled = ({ title, children, path }: { title: string; children?: ReactNode; path?: string }) => (
    <div className="labeled">
        <span className="labeled__title">{title}</span>
        {path ? (
            <span className="labeled__path selectable" title={path}>
                {middle(path, PATH_CHARS)}
            </span>
        ) : (
            <span className="selectable">{children}</span>
        )}
    </div>
);

const Thumb = ({ api, repo, pr, path, onOpen }: { api: ApiClient; repo: string; pr: number; path: string; onOpen: () => void }) => {
    const [url, setUrl] = useState<string | null>(null);
    useEffect(() => {
        if (!isVideo(path)) thumbUrl(api, repo, pr, path).then(setUrl, () => setUrl(null));
    }, [api, repo, pr, path]);
    return (
        <div className="thumb" title={fileName(path)} onClick={onOpen}>
            {isVideo(path) ? (
                <span className="thumb__video">
                    <Icon id="i-play-circle-fill" />
                    {t('qa.report.video')}
                </span>
            ) : url ? (
                <img src={url} alt={fileName(path)} />
            ) : (
                <Icon id="i-image" />
            )}
        </div>
    );
};

export const QaSheet = ({ api, data, repo, prId, onClose }: { api: ApiClient; data: Data; repo: string; prId: number; onClose: () => void }) => {
    const pr = data.snapshots[repo]?.prs.find((item) => item.id === prId);
    const qa = (data.qas.find((item) => item.repo === repo && item.pr === prId) ?? null) as Qa | null;
    const hasReport = !!qa?.run || ['run-queued', 'running', 'failed'].includes(qa?.state ?? '');
    const [tab, setTab] = useState<Tab>(hasReport ? 'report' : 'plan');
    const [note, setNote] = useState(qa?.note ?? '');
    const [extra, setExtra] = useState('');
    const [skipped, setSkipped] = useState<Set<string>>(new Set());
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [copied, setCopied] = useState(false);
    const [saving, setSaving] = useState(false);
    const [serviceError, setServiceError] = useState<string | null>(null);
    const [now, setNow] = useState(Date.now());
    const state = useRef(qa?.state);

    // При смене состояния вкладка переключается сама
    useEffect(() => {
        if (qa?.state === state.current) return;
        state.current = qa?.state;
        if (['run-queued', 'running', 'done', 'failed'].includes(qa?.state ?? '')) setTab('report');
        if (['planning-queued', 'planning', 'planned', 'plan-failed'].includes(qa?.state ?? '')) setTab('plan');
    }, [qa?.state]);

    const working = qa?.state === 'planning' || qa?.state === 'running';
    useEffect(() => {
        if (!working) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [working]);

    if (!pr) return null;
    const active = ACTIVE.includes(qa?.state ?? '');
    const plan = qa?.plan ?? null;
    const run = qa?.run ?? null;
    const extraCases = extra.split('\n').map((line) => line.trim()).filter(Boolean);
    const selected = (plan?.cases ?? []).filter((item) => !skipped.has(item.id));
    // Как needsBrowser в qa.mjs: свой кейс человека может оказаться e2e
    const needsBrowser = extraCases.length > 0 || selected.some((item) => levelKey(item.level) === 'e2e');
    const onReport = tab === 'report' && hasReport;

    const act = async (request: () => Promise<{ error?: unknown }>) => {
        const { error } = await request();
        setServiceError(error ? errorText(error as never) : null);
        return !error;
    };

    const requestPlan = () => act(() => api.POST('/qa/{repo}/{pr}/plan', { params: { path: { repo, pr: prId } }, body: { note } }));

    const requestRun = async () => {
        const confirmed = await confirm(
            needsBrowser
                ? t('qa.confirm.browser', { cases: cases(selected.length + extraCases.length), load: t(isWindows ? 'qa.confirm.loadWindows' : 'qa.confirm.loadMac') })
                : t('qa.confirm.unit', { cases: cases(selected.length) }),
            { title: t('qa.confirm.title', { pr: pr.id }), kind: 'info', okLabel: t('qa.confirm.ok'), cancelLabel: t('common.action.cancel') },
        );
        if (confirmed) act(() => api.POST('/qa/{repo}/{pr}/run', { params: { path: { repo, pr: prId } }, body: { skip: [...skipped].sort(), add: extraCases, note } }));
    };

    const save = async () => {
        setSaving(true);
        await act(() => api.POST('/qa/{repo}/{pr}/save', { params: { path: { repo, pr: prId } } }));
        setSaving(false);
    };

    const copy = async () => {
        const { data: answer, error } = await api.GET('/qa/{repo}/{pr}/markdown', { params: { path: { repo, pr: prId }, query: { plan: !onReport } } });
        const text = (answer as { output?: string } | undefined)?.output;
        if (error || !text) return setServiceError(error ? errorText(error) : t('qa.sheet.nothingToCopy'));
        try {
            await navigator.clipboard.writeText(text);
        } catch (failure) {
            return setServiceError(t('qa.sheet.copyFailed', { error: String(failure) }));
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const openViewer = (runDir: string, files: string[], index: number) => invoke('open_viewer', { query: viewerQuery({ repo, pr: prId, runDir, files, index }) }).catch((reason) => setServiceError(String(reason)));

    const started = parse(qa?.startedAt);
    const elapsed = started ? ` · ${stepDuration((now - started.getTime()) / 1000)}` : '';
    const statusLine = !qa ? null : ['planning-queued', 'run-queued'].includes(qa.state) ? (
        <span className="report-status">
            <Icon id="i-clock" />
            <span className="report-status__text" style={{ color: 'var(--label-2)' }}>
                {qa.state === 'run-queued' ? t('qa.state.runQueued') : t('qa.state.planQueued')}
            </span>
        </span>
    ) : working ? (
        <span className="report-status" style={tone('var(--blue)')}>
            <Icon id="i-hourglass" className="icon hourglass" />
            <span className="report-status__text">
                {(qa.state === 'planning' ? t('qa.state.planning') : (qa.step ?? t('qa.state.running'))) + elapsed}
                {/* Во время прогона действие видно в ходе прогона под текущим шагом */}
                {qa.activity && (qa.state === 'planning' || !qa.steps?.length) && (
                    <span className="report-status__activity" title={qa.activity}>
                        {middle(qa.activity, PATH_CHARS)}
                    </span>
                )}
            </span>
        </span>
    ) : qa.state === 'planned' ? (
        <span className="report-status" style={tone('var(--accent)')}>
            <Icon id="i-check-circle-fill" />
            <span className="report-status__text" style={{ color: 'var(--label)' }}>
                {t('qa.state.planned', { cases: cases(plan?.cases.length ?? 0) })}
            </span>
        </span>
    ) : qa.state === 'done' && run ? (
        <span className="report-status" style={tone(runColor(run))}>
            <Icon id="i-seal-check-fill" />
            <span className="report-status__text" style={{ color: 'var(--label)' }}>
                {count(run, 'failed') > 0 ? t('qa.state.doneWithErrors') : count(run, 'passed') === run.cases.length ? t('qa.state.donePassed') : t('qa.state.done')}
            </span>
        </span>
    ) : qa.state === 'plan-failed' || qa.state === 'failed' ? (
        <span className="report-status" style={tone('var(--orange)')}>
            <Icon id="i-warning-fill" />
            <span className="report-status__text">{qa.state === 'plan-failed' ? t('qa.state.planFailed') : t('qa.state.runFailed')}</span>
        </span>
    ) : null;

    const noteSection = (
        <Section title={t('qa.note.title')} footer={t('qa.note.footer')}>
            <div className="card-pad card-pad--end">
                <textarea className="text-field text-field--multiline" placeholder={t('qa.note.placeholder')} value={note} onChange={(event) => setNote(event.target.value)} />
                <button className="button" disabled={active} onClick={requestPlan}>
                    {plan ? t('qa.note.remakePlan') : t('qa.note.makePlan')}
                </button>
            </div>
        </Section>
    );

    const planTab = (
        <>
            {qa?.state === 'plan-failed' && qa.error && <ErrorBox text={qa.error} />}
            {plan ? (
                <>
                    {!sameCommit(qa?.planHead, pr.head) && !['planning-queued', 'planning'].includes(qa?.state ?? '') && (
                        <Banner title={t('qa.plan.staleTitle')} text={t('qa.plan.staleText', { planHead: qa?.planHead ?? '', head: pr.head })} />
                    )}
                    {!plan.testable && <Banner icon="i-eye-slash" title={t('qa.plan.untestableTitle')} text={t('qa.plan.untestableText')} />}
                    <Section title={t('qa.plan.summary', { kind: kind(plan.kind) })}>
                        <div className="report-paragraph md">
                            <Markdown text={plan.summary} />
                        </div>
                    </Section>
                    <Section title={t('qa.plan.expected')}>
                        <div className="report-paragraph md">
                            <Markdown text={plan.expected} />
                        </div>
                    </Section>
                    {plan.risks.length > 0 && (
                        <Section title={t('qa.plan.risks', { count: plan.risks.length })}>
                            <Rows
                                items={plan.risks.map((risk, index) => (
                                    <div key={index} className="place md">
                                        <span className="place__marker" style={tone('var(--orange)')}>
                                            <Icon id="i-warning" />
                                        </span>
                                        <div className="place__body selectable">
                                            <span className="place__title">
                                                <Markdown text={risk.title} />
                                            </span>
                                            {risk.path && (
                                                <span className="place__location" title={risk.path}>
                                                    {middle(risk.path, PATH_CHARS)}
                                                </span>
                                            )}
                                            <span>
                                                <Markdown text={risk.details} />
                                            </span>
                                        </div>
                                    </div>
                                ))}
                            />
                        </Section>
                    )}
                    <Section title={t('qa.plan.cases', { selected: selected.length, total: plan.cases.length })} footer={plan.cases.length ? t('qa.plan.casesFooter') : null}>
                        {!plan.cases.length && <div className="section__empty">{t('qa.plan.noCases')}</div>}
                        <Rows
                            divider="row-divider"
                            style={{ '--divider-inset': '36px' } as CSSProperties}
                            items={plan.cases.map((item) => {
                                const on = !skipped.has(item.id);
                                const open = expanded.has(item.id);
                                const toggleOpen = () => setExpanded((current) => (current.has(item.id) ? new Set([...current].filter((id) => id !== item.id)) : new Set([...current, item.id])));
                                return (
                                    <div key={item.id} className={`qa-case${on ? '' : ' qa-case--off'}${open ? ' qa-case--expanded' : ''}`}>
                                        <input
                                            type="checkbox"
                                            className="checkbox"
                                            checked={on}
                                            disabled={active}
                                            onChange={() => setSkipped((current) => (on ? new Set([...current, item.id]) : new Set([...current].filter((id) => id !== item.id))))}
                                        />
                                        <div className="qa-case__body" onClick={toggleOpen}>
                                            <div className="qa-case__head">
                                                <span className="qa-case__id">{item.id}</span>
                                                <span className="qa-case__title md">
                                                    <Markdown text={item.title} />
                                                </span>
                                                <Tags item={item} />
                                                <Icon id="i-chevron-right" className="icon qa-case__chevron" />
                                            </div>
                                            {!open && item.expect && (
                                                <div className="qa-case__expect md">
                                                    <Markdown text={item.expect} />
                                                </div>
                                            )}
                                            {open && (
                                                <>
                                                    {item.target && <Labeled title={t('qa.plan.target')} path={item.target} />}
                                                    {item.preconditions && (
                                                        <Labeled title={t('qa.plan.preconditions')}>
                                                            <Markdown text={item.preconditions} />
                                                        </Labeled>
                                                    )}
                                                    {item.steps.length > 0 && (
                                                        <div className="labeled">
                                                            <span className="labeled__title">{t('qa.plan.steps')}</span>
                                                            <ol className="labeled__steps md selectable">
                                                                {item.steps.map((step, index) => (
                                                                    <li key={index}>
                                                                        <Markdown text={step} />
                                                                    </li>
                                                                ))}
                                                            </ol>
                                                        </div>
                                                    )}
                                                    {item.expect && (
                                                        <Labeled title={t('qa.plan.expect')}>
                                                            <Markdown text={item.expect} />
                                                        </Labeled>
                                                    )}
                                                </>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        />
                    </Section>
                    <Section title={t('qa.plan.extraTitle')} footer={t('qa.plan.extraFooter')}>
                        <div className="card-pad">
                            <textarea className="text-field text-field--multiline" placeholder={t('qa.plan.extraPlaceholder')} value={extra} onChange={(event) => setExtra(event.target.value)} />
                        </div>
                    </Section>
                    {plan.notTestable.length > 0 && (
                        <Section title={t('qa.plan.notTestable', { count: plan.notTestable.length })}>
                            <Rows
                                items={plan.notTestable.map((item, index) => (
                                    <div key={index} className="place md">
                                        <span className="place__marker">
                                            <Icon id="i-eye-slash" />
                                        </span>
                                        <div className="place__body selectable">
                                            <span className="place__title">
                                                <Markdown text={item.what} />
                                            </span>
                                            <span style={{ color: 'var(--label-2)' }}>
                                                <Markdown text={item.why} />
                                            </span>
                                        </div>
                                    </div>
                                ))}
                            />
                        </Section>
                    )}
                    <Details
                        rows={[
                            [t('qa.plan.planHead'), qa?.planHead],
                            [t('qa.plan.madeAt'), ['planning-queued', 'planning'].includes(qa?.state ?? '') ? null : exactDate(qa?.finishedAt)],
                            [t('qa.plan.cost'), qa?.usage?.costUsd != null ? money(qa.usage.costUsd) : null],
                        ]}
                    />
                    {noteSection}
                </>
            ) : ['planning-queued', 'planning'].includes(qa?.state ?? '') ? (
                <span style={{ fontSize: 'var(--text-body)', color: 'var(--label-2)' }}>{t('qa.plan.planning')}</span>
            ) : (
                noteSection
            )}
        </>
    );

    const report = (current: Run) => {
        const repoName = (current.saved?.checkout ?? repo).split('/').pop();
        return (
            <>
                {current.planHead && !sameCommit(current.planHead, current.head) && <Banner title={t('qa.report.commitsDifferTitle')} text={t('qa.report.commitsDifferText', { planHead: current.planHead, head: current.head })} />}
                {!sameCommit(current.head, pr.head) && <Banner title={t('qa.report.staleTitle')} text={t('qa.report.staleText', { head: current.head, prHead: pr.head })} />}
                <Section title={t('qa.report.summary')}>
                    <div className="card-pad">
                        {current.summary && (
                            <span className="md selectable">
                                <Markdown text={current.summary} />
                            </span>
                        )}
                        <div className="status-grid">
                            {STATUS_ORDER.filter((value) => count(current, value) > 0).map((value) => {
                                const [title, icon, color] = status(value);
                                return (
                                    <span key={value} className="status-grid__item" style={tone(color)}>
                                        <Icon id={icon} />
                                        <span className="status-grid__count">{count(current, value)}</span>
                                        <span className="status-grid__title">{title}</span>
                                    </span>
                                );
                            })}
                        </div>
                    </div>
                </Section>
                {current.envNotes && (
                    <Section title={t('qa.report.environment')}>
                        <div className="report-paragraph md">
                            <Markdown text={current.envNotes} />
                        </div>
                    </Section>
                )}
                <Section title={t('qa.report.cases', { count: current.cases.length })}>
                    <Rows
                        divider="row-divider"
                        style={{ '--divider-inset': '36px' } as CSSProperties}
                        items={current.cases.map((item) => {
                            const [title, icon, color] = status(item.status);
                            const media = (item.evidence?.files ?? []).filter(isMedia);
                            const test = item.savePath ?? item.evidence?.specFile;
                            return (
                                <div key={item.id} className="qa-case qa-case--result">
                                    <span className="qa-case__status" style={tone(color)}>
                                        <Icon id={icon} />
                                    </span>
                                    <div className="qa-case__body">
                                        <div>
                                            <div className="qa-case__head">
                                                <span className="qa-case__id">{item.id}</span>
                                                <span className="qa-case__title md">
                                                    <Markdown text={item.title} />
                                                </span>
                                                <Tags item={item} />
                                            </div>
                                            {/* Жёлтый текст на светлом фоне не читается — основным цветом */}
                                            <span className="qa-case__verdict" style={tone(color === 'var(--yellow)' ? 'var(--label)' : color)}>
                                                {title}
                                            </span>
                                        </div>
                                        {test && <Labeled title={t('qa.report.test')} path={test} />}
                                        {item.checked && (
                                            <Labeled title={t('qa.report.checked')}>
                                                <Markdown text={item.checked} />
                                            </Labeled>
                                        )}
                                        {item.bug && (
                                            <div className="bug-box md selectable">
                                                <span className="bug-box__title">
                                                    <Icon id="i-bug-fill" />
                                                    <Markdown text={item.bug.title} />
                                                </span>
                                                <span>
                                                    <Markdown text={item.bug.details} />
                                                </span>
                                            </div>
                                        )}
                                        {item.notes && (
                                            <Labeled title={t('qa.report.notes')}>
                                                <Markdown text={item.notes} />
                                            </Labeled>
                                        )}
                                        {item.status === 'unconfirmed' && (
                                            <span style={{ fontSize: 'var(--text-callout)', color: 'var(--label-2)' }}>
                                                {t('qa.report.unconfirmed', {
                                                    claimed: item.claimed ? status(item.claimed)[0].toLowerCase() : t('qa.report.noAnswer'),
                                                    result: item.evidence?.status ? playwright(item.evidence.status) : t('qa.report.noTest'),
                                                })}
                                            </span>
                                        )}
                                        {item.evidence?.errors.length ? (
                                            <div className="labeled">
                                                <span className="labeled__title">{t('qa.report.playwrightErrors')}</span>
                                                <div className="code-box selectable">{item.evidence.errors.join('\n\n')}</div>
                                            </div>
                                        ) : null}
                                        {media.length > 0 && (
                                            <div className="gallery">
                                                {media.map((file, index) => (
                                                    <Thumb key={file} api={api} repo={repo} pr={prId} path={file} onOpen={() => openViewer(current.runDir, media, index)} />
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    />
                </Section>
                {current.tests?.length ? (
                    <Section
                        title={t('qa.tests.title', { count: current.tests.length })}
                        footer={t('qa.tests.footer', { repo, pr: pr.id })}
                    >
                        <Rows
                            items={current.tests.map((test, index) => (
                                <div key={index} className="place">
                                    <span className="place__marker">
                                        <Icon id="i-file-text" />
                                    </span>
                                    <div className="place__body">
                                        <span className="labeled__path selectable" title={test.target}>
                                            {middle(test.target, PATH_CHARS)}
                                        </span>
                                        <span style={{ fontSize: 'var(--text-subhead)', color: 'var(--label-2)' }}>
                                            {level(test.level)} · {test.cases.join(', ')}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        />
                        <div className="row-divider" />
                        <div className="save-row">
                            {current.saved ? (
                                <>
                                    <Icon id="i-check-circle-fill" className="icon lead-icon lead-icon--small" style={{ '--c': 'var(--green)' } as CSSProperties} />
                                    <span className="save-row__text">
                                        <span className="save-row__title">
                                            {current.saved.branch
                                                ? t('qa.tests.savedOnBranch', { ago: ago(current.saved.at), repo: repoName ?? '', branch: current.saved.branch })
                                                : t('qa.tests.saved', { ago: ago(current.saved.at), repo: repoName ?? '' })}
                                        </span>
                                        {current.saved.files
                                            .filter((file) => file.path !== file.wanted)
                                            .map((file) => (
                                                <span key={file.path} className="save-row__note">
                                                    {t('qa.tests.renamed', { wanted: file.wanted, path: file.path })}
                                                </span>
                                            ))}
                                        {(current.saved.prBranch ?? current.branch) && current.saved.branch !== (current.saved.prBranch ?? current.branch) && (
                                            <span className="save-row__warning">{t('qa.tests.otherBranch', { branch: current.saved.prBranch ?? current.branch ?? '' })}</span>
                                        )}
                                    </span>
                                </>
                            ) : (
                                <span className="save-row__text">
                                    <span style={{ color: 'var(--label-2)' }}>{t('qa.tests.notSaved')}</span>
                                </span>
                            )}
                            {saving && <Icon id="i-spinner" />}
                            <button className="button" disabled={saving || active} onClick={save}>
                                {current.saved ? t('qa.tests.saveAgain') : t('qa.tests.save', { repo })}
                            </button>
                            {current.saved && (
                                <button className="button" onClick={() => invoke('reveal_path', { path: `${current.saved!.checkout}/${current.saved!.files[0]?.path ?? ''}` }).catch(() => {})}>
                                    {t('qa.tests.reveal')}
                                </button>
                            )}
                        </div>
                    </Section>
                ) : null}
                <Details
                    rows={[
                        [t('qa.report.frontend'), current.head],
                        [t('qa.report.backend'), current.backend ? `${current.backend.ref.replace('origin/', '')} · ${current.backend.commit}` : null],
                        [t('qa.report.finishedAt'), exactDate(qa?.finishedAt)],
                        [t('qa.report.costAndTime'), [current.usage?.costUsd != null ? money(current.usage.costUsd) : null, current.durationSec != null ? stepDuration(current.durationSec) : null].filter(Boolean).join(' · ')],
                        [t('qa.report.runDir'), current.runDir],
                    ]}
                />
            </>
        );
    };

    const reportTab = qa && (
        <>
            {qa.steps?.length && (qa.state === 'running' || qa.state === 'failed') ? <Steps title={t('qa.report.progress')} steps={qa.steps} active={qa.state === 'running'} failed={qa.state === 'failed'} finishedAt={qa.finishedAt} activity={qa.activity} /> : null}
            {qa.state === 'failed' && qa.error && <ErrorBox text={qa.error} />}
            {run ? (
                <>
                    {qa.state !== 'done' && <span className="sheet__note">{t('qa.report.previous')}</span>}
                    {report(run)}
                </>
            ) : (
                qa.state === 'run-queued' && <span style={{ fontSize: 'var(--text-body)', color: 'var(--label-2)' }}>{t('qa.report.runQueued')}</span>
            )}
        </>
    );

    return (
        <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()} onKeyDown={(event) => event.key === 'Escape' && onClose()}>
            <div className="sheet sheet--large sheet--tall" role="dialog" aria-label={t('qa.sheet.title', { pr: pr.id })}>
                <div className="sheet__head">
                    <div className="sheet__titles">
                        <div className="sheet__title">{t('qa.sheet.title', { pr: pr.id })}</div>
                        <div className="sheet__subtitle sheet__subtitle--line">{pr.title}</div>
                    </div>
                    {hasReport && plan && (
                        <div className="segmented">
                            <button className="segmented__item" aria-selected={tab === 'plan'} onClick={() => setTab('plan')}>
                                {t('qa.sheet.plan')}
                            </button>
                            <button className="segmented__item" aria-selected={tab === 'report'} onClick={() => setTab('report')}>
                                {t('qa.sheet.report')}
                            </button>
                        </div>
                    )}
                    <button className="round-button round-button--close" title={t('common.action.close')} onClick={onClose}>
                        <Icon id="i-close" />
                    </button>
                </div>
                {statusLine}
                {serviceError && <ErrorBox text={serviceError} />}
                <div className="sheet__body">{onReport ? reportTab : planTab}</div>
                <div className="sheet__footer">
                    <button className="button" onClick={() => openUrl(pr.url).catch(() => {})}>
                        {t('qa.sheet.openPr')}
                    </button>
                    <button className="button" disabled={onReport ? !run : !plan} onClick={copy}>
                        {copied ? t('qa.sheet.copied') : onReport ? t('qa.sheet.copyReport') : t('qa.sheet.copyPlan')}
                    </button>
                    {onReport && run && (
                        <button className="button" onClick={() => invoke('open_path', { path: run.runDir }).catch(() => {})}>
                            {t('qa.sheet.openRunDir')}
                        </button>
                    )}
                    <span className="spacer" />
                    {active ? (
                        <button className="button button--destructive" onClick={() => act(() => api.POST('/qa/{repo}/{pr}/stop', { params: { path: { repo, pr: prId } } }))}>
                            {t('qa.sheet.stop')}
                        </button>
                    ) : onReport ? (
                        <button className="button" disabled={!plan} onClick={() => setTab('plan')}>
                            {t('qa.sheet.newRun')}
                        </button>
                    ) : (
                        plan && (
                            <button
                                className="button button--prominent"
                                disabled={!selected.length && !extraCases.length}
                                title={needsBrowser ? t('qa.sheet.startRunBrowserHint') : t('qa.sheet.startRunUnitHint')}
                                onClick={requestRun}
                            >
                                {t('qa.sheet.startRun')}
                            </button>
                        )
                    )}
                </div>
            </div>
        </div>
    );
};

