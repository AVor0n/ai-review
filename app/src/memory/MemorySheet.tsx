import { confirm } from '../dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { errorText, type ApiClient } from '../api/client';
import { CommandError } from '../components/CommandError';
import { Icon } from '../components/Icon';
import { DiffLine, Markdown } from '../components/Markdown';
import { t } from '../i18n';
import { ago, formatDate, parse } from '../model/format';
import { decimal } from '../stats/format';
import { changeDiff } from '../model/wordDiff';
import { jobsOf, lastLine, updateJobs, useJobs } from './jobs';

// Лист «Память ревьюеров» — перенос MemorySheet, LessonRow, LessonEditor (SettingsView.swift), MemoryReviewPanel и MemoryHistoryPanel.
// Разметка — шаблоны tpl-sheet-* макета 2026-11-26-tauri-memory.html
type Usage = { applied: number; findings: number; addressed: number; dismissed: number };
type Lesson = {
    id: string;
    text: string;
    at: string;
    manual?: boolean;
    edited?: boolean;
    source?: { pr: number; url: string; authors?: string[] | null; kind?: string | null; mergedFrom?: string[] | null } | null;
    usage?: Usage | null;
};
type Memory = { since: string | null; runs: number; broken: string | null; lessons: Lesson[] };
type Action = { type: string; ids: string[]; text: string; reason: string };
type Plan = { at: string; summary: string; actions: Action[]; usage?: { costUsd?: number | null } | null; outdated?: boolean | null };
type Item = { id: string; text: string; reason?: string | null };
type Change = {
    at: string;
    kind: string;
    reason?: string | null;
    pr?: number | null;
    url?: string | null;
    added?: Item[] | null;
    removed?: Item[] | null;
    changed?: { id: string; before: string; after: string; reason?: string | null }[] | null;
    merged?: { from: Item[]; into: Item; reason?: string | null }[] | null;
};
type Tab = 'rules' | 'review' | 'history';

const HISTORY_LIMIT = 100;
const GROUPS = ['merge', 'rewrite', 'drop'] as const;

const changes = (plan: Plan) => plan.actions.filter((action) => action.type !== 'keep').length;
const counts = (plan: Plan) => {
    const before = plan.actions.reduce((total, action) => total + action.ids.length, 0);
    const removed = plan.actions.reduce((total, action) => total + (action.type === 'drop' ? action.ids.length : action.type === 'merge' ? action.ids.length - 1 : 0), 0);
    return { before, after: before - removed };
};

const origin = (lesson: Lesson) => {
    if (lesson.manual) return t('memory.lesson.manual');
    if (lesson.edited && lesson.source) return t('memory.lesson.edited', { pr: lesson.source.pr });
    if (!lesson.source) return '';
    const from = t(lesson.source.kind === 'review' ? 'memory.lesson.fromReview' : 'memory.lesson.fromReply', { pr: lesson.source.pr });
    return [lesson.source.mergedFrom ? t('memory.lesson.merged') : null, from, lesson.source.authors?.join(', ') || null].filter(Boolean).join(' · ');
};

const idle = (usage: Usage | null | undefined) => !usage || usage.applied + usage.findings === 0;

const usageText = (usage: Usage | null | undefined) => {
    if (!usage || idle(usage)) return t('memory.usage.idle');
    const parts = [t('memory.usage.applied', { count: usage.applied })];
    if (usage.findings > 0) parts.push(t('memory.usage.findings', { count: usage.findings, addressed: usage.addressed, dismissed: usage.dismissed }));
    return parts.join(' · ');
};

const elapsed = (seconds: number) => (seconds < 60 ? t('common.time.seconds', { seconds }) : t('common.time.minutesSeconds', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 }));

const KIND_COLORS: Record<string, string | null> = {
    learn: 'var(--fate-waiting)',
    add: 'var(--fate-waiting)',
    edit: null,
    remove: 'var(--fate-dismissed)',
    evict: 'var(--fate-dismissed)',
    review: 'var(--purple)',
    restore: null,
};

const kindTitle = (kind: string) =>
    kind === 'learn' || kind === 'add' || kind === 'edit' || kind === 'remove' || kind === 'evict' || kind === 'review' || kind === 'restore' ? t(`memory.history.kind.${kind}`) : kind;

// Журнал читают по датам, поэтому дата точная: «26 нояб., 11:42», с годом — если не текущий
const exactDate = (iso: string) => {
    const date = parse(iso);
    if (!date) return iso;
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return formatDate(date, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(sameYear ? {} : { year: 'numeric' }) });
};

const Diff = ({ before, after }: { before: string[]; after: string }) => {
    const diff = changeDiff(before, after);
    return (
        <div className="diff md">
            <span className="diff__label">{t('memory.diff.before')}</span>
            <div className="diff__lines diff__before selectable">
                {diff.before.map((runs, index) => (
                    <DiffLine key={index} runs={runs} mark="del" />
                ))}
            </div>
            <span className="diff__label">{t('memory.diff.after')}</span>
            <div className="diff__lines selectable">
                <DiffLine runs={diff.after} mark="ins" />
            </div>
        </div>
    );
};

const ReviewIntro = () => (
    <div className="info-card">
        <div className="info-card__row">
            <Icon id="i-fix" className="icon info-card__icon" />
            <div className="info-card__text">
                <span className="info-card__title">{t('memory.review.introTitle')}</span>
                <span className="info-card__body">{t('memory.review.introBody')}</span>
            </div>
        </div>
        <span className="info-card__hint">{t('memory.review.introHint')}</span>
    </div>
);

const ErrorCard = ({ title, text }: { title: string; text: string }) => (
    <div className="info-card">
        <span className="status-label status-label--strong" style={{ '--c': 'var(--orange)' } as React.CSSProperties}>
            <Icon id="i-warning-fill" />
            {title}
        </span>
        <span className="info-card__mono selectable">{text.trim()}</span>
    </div>
);

const Done = ({ text }: { text: string }) => (
    <span className="status-label" style={{ '--c': 'var(--fate-addressed)' } as React.CSSProperties}>
        <Icon id="i-check-circle-fill" />
        {text}
    </span>
);

export const MemorySheet = ({
    api,
    slug,
    memoryPath,
    canOpenInCode,
    openInCode,
    fresh,
    version,
    onClose,
}: {
    api: ApiClient;
    slug: string;
    memoryPath: string;
    canOpenInCode: boolean;
    openInCode: (path: string) => void;
    fresh: Set<string>;
    version: number;
    onClose: () => void;
}) => {
    const jobs = useJobs(slug);
    const [memory, setMemory] = useState<Memory | null>(null);
    // undefined — план ещё не прочитан
    const [plan, setPlan] = useState<Plan | null | undefined>(undefined);
    const [history, setHistory] = useState<Change[]>([]);
    const [tab, setTab] = useState<Tab>(() => (jobsOf(slug).reviewing ? 'review' : 'rules'));
    const [draft, setDraft] = useState('');
    const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
    const [historyPrs, setHistoryPrs] = useState(100);
    const [now, setNow] = useState(Date.now());
    // Ошибка правки, добавления или удаления правила: текст правила при этом не теряется
    const [commandError, setCommandError] = useState<string | null>(null);

    const loadPlan = useCallback(async () => setPlan(((await api.GET('/memory/{repo}/plan', { params: { path: { repo: slug } } })).data as Plan | null | undefined) ?? null), [api, slug]);
    const loadHistory = useCallback(async () => setHistory((((await api.GET('/memory/{repo}/history', { params: { path: { repo: slug } } })).data as Change[] | undefined) ?? []).slice(-HISTORY_LIMIT).reverse()), [api, slug]);
    const loadMemory = useCallback(async () => setMemory(((await api.GET('/memory/{repo}', { params: { path: { repo: slug } } })).data as Memory | undefined) ?? null), [api, slug]);

    // Перечитываем при открытии и при каждом изменении памяти: новое правило, правка, применённый план
    useEffect(() => {
        loadMemory();
        loadPlan();
        loadHistory();
    }, [loadMemory, loadPlan, loadHistory, version]);

    // Открывается сразу на «Разборе», если есть готовый план (или идёт разбор — это решено при открытии)
    const [planChecked, setPlanChecked] = useState(false);
    useEffect(() => {
        if (planChecked || plan === undefined) return;
        setPlanChecked(true);
        if (plan) setTab('review');
    }, [plan, planChecked]);

    useEffect(() => {
        if (!jobs.reviewing) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [jobs.reviewing]);

    const run = async (request: () => Promise<{ data?: unknown; error?: unknown }>) => {
        const result = await request();
        return result.error ? { ok: false, output: errorText(result.error as never) } : { ok: true, output: (result.data as { output?: string } | undefined)?.output ?? '' };
    };

    const add = async () => {
        const text = draft.trim();
        if (!text) return;
        const result = await run(() => api.POST('/memory/{repo}/lessons', { params: { path: { repo: slug } }, body: { text } }));
        setCommandError(result.ok ? null : result.output);
        if (result.ok) setDraft('');
        loadMemory();
    };

    const save = async () => {
        if (!editing || !editing.text.trim()) return;
        const { id, text } = editing;
        const result = await run(() => api.PUT('/memory/{repo}/lessons/{id}', { params: { path: { repo: slug, id } }, body: { text: text.trim() } }));
        setCommandError(result.ok ? null : result.output);
        if (result.ok) setEditing(null);
        loadMemory();
    };

    const remove = async (id: string) => {
        const result = await run(() => api.DELETE('/memory/{repo}/lessons/{id}', { params: { path: { repo: slug, id } } }));
        setCommandError(result.ok ? null : result.output);
        loadMemory();
    };

    // Разбор идёт 1–3 минуты; состояние вне листа, поэтому лист можно закрыть и открыть снова
    const review = async () => {
        if (jobsOf(slug).reviewing) return;
        updateJobs(slug, { reviewing: Date.now(), reviewError: undefined, applied: undefined });
        const result = await run(() => api.POST('/memory/{repo}/review', { params: { path: { repo: slug } } }));
        updateJobs(slug, { reviewing: undefined, reviewError: result.ok ? undefined : result.output });
        loadPlan();
    };

    const apply = async () => {
        if (jobsOf(slug).applying) return;
        updateJobs(slug, { applying: true, reviewError: undefined });
        const result = await run(() => api.POST('/memory/{repo}/apply', { params: { path: { repo: slug } } }));
        updateJobs(slug, result.ok ? { applying: false, applied: lastLine(result.output) } : { applying: false, reviewError: result.output });
        if (result.ok) setPlan(null);
        loadPlan();
        loadMemory();
        loadHistory();
    };

    const discard = async () => {
        setPlan(null);
        updateJobs(slug, { reviewError: undefined });
        const result = await run(() => api.DELETE('/memory/{repo}/plan', { params: { path: { repo: slug } } }));
        if (!result.ok) updateJobs(slug, { reviewError: result.output });
    };

    // Можно ли откатить, решает сервис: он сверяет память с той, что осталась после разбора, и откажет, если её меняли
    const restore = async () => {
        const confirmed = await confirm(t('memory.restore.body'), { title: t('memory.restore.title'), kind: 'warning', okLabel: t('memory.restore.ok'), cancelLabel: t('common.action.cancel') });
        if (!confirmed || jobsOf(slug).restoring) return;
        updateJobs(slug, { restoring: true, historyError: undefined, restored: undefined });
        const result = await run(() => api.POST('/memory/{repo}/restore', { params: { path: { repo: slug } } }));
        updateJobs(slug, result.ok ? { restoring: false, restored: lastLine(result.output) } : { restoring: false, historyError: result.output });
        loadHistory();
        loadMemory();
        loadPlan();
    };

    const learn = async () => {
        if (jobsOf(slug).learning) return;
        updateJobs(slug, { learning: true, learnResult: undefined });
        const result = await run(() => api.POST('/memory/{repo}/learn', { params: { path: { repo: slug } }, body: { prs: historyPrs } }));
        updateJobs(slug, { learning: false, learnResult: result.ok ? lastLine(result.output) : result.output });
        loadMemory();
    };

    const lessons = [...(memory?.lessons ?? [])].reverse();
    const broken = memory?.broken ?? null;
    const reviewing = jobs.reviewing !== undefined;
    const showsTabs = memory !== null && !broken && lessons.length > 0;
    const showsReviewActions = showsTabs && tab === 'review';
    const texts = new Map<string, string>();
    for (const lesson of memory?.lessons ?? []) if (!texts.has(lesson.id)) texts.set(lesson.id, lesson.text);
    const lessonText = (id: string) => texts.get(id) ?? t('memory.lesson.missing', { id });
    // Откатить можно только последний применённый разбор, и только если после него не было отката
    const restorableAt = history.find((entry) => entry.kind === 'review' || entry.kind === 'restore');
    const restorable = restorableAt?.kind === 'review' ? restorableAt.at : null;

    const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && !editing) onClose();
    };

    const footer = showsReviewActions ? (
        <div className="sheet__footer">
            {plan && !reviewing && (
                <button className="button" disabled={jobs.applying} title={t('memory.review.discardHint')} onClick={discard}>
                    {changes(plan) === 0 ? t('memory.review.removePlan') : t('memory.review.discard')}
                </button>
            )}
            <span className="spacer" />
            {jobs.applying ? (
                <span className="status-label" style={{ '--c': 'var(--label-2)' } as React.CSSProperties}>
                    <Icon id="i-spinner" />
                    {t('memory.review.applying')}
                </span>
            ) : plan && !reviewing && !plan.outdated && changes(plan) > 0 ? (
                <button className="button button--prominent" title={t('memory.review.applyHint', { slug })} onClick={apply}>
                    {t('memory.review.apply')}
                </button>
            ) : (
                !reviewing && (
                    <button className={`button${!plan || plan.outdated ? ' button--prominent' : ''}`} onClick={review}>
                        {plan ? t('memory.review.again') : t('memory.review.start')}
                    </button>
                )
            )}
        </div>
    ) : (
        // В повреждённый файл сервис не пишет — добавить правило всё равно не получится
        <div className="sheet__footer" style={broken ? { opacity: 'var(--disabled-opacity)' } : undefined}>
            <input className="text-field" placeholder={t('memory.add.placeholder')} value={draft} disabled={!!broken} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && add()} />
            <button className="button" disabled={!!broken || !draft.trim()} onClick={add}>
                {t('memory.add.button')}
            </button>
        </div>
    );

    return (
        <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()} onKeyDown={onKey}>
            <div className="sheet" role="dialog" aria-label={t('memory.title', { slug })}>
                <div className="sheet__head">
                    <div className="sheet__titles">
                        <div className="sheet__title">{t('memory.title', { slug })}</div>
                        <div className="sheet__subtitle">{t('memory.subtitle')}</div>
                    </div>
                    {canOpenInCode && (
                        <button className="round-button" title={t('memory.openInCode')} onClick={() => openInCode(memoryPath)}>
                            <Icon id="i-open-external" />
                        </button>
                    )}
                    <button className="round-button round-button--close" title={t('common.action.close')} onClick={onClose}>
                        <Icon id="i-close" />
                    </button>
                </div>

                {commandError && <CommandError text={commandError} onClose={() => setCommandError(null)} />}
                {broken ? (
                    <div className="sheet__body" style={{ '--sheet-body': '300px' } as React.CSSProperties}>
                        <div className="info-card" style={{ gap: 'var(--space-8)' }}>
                            <span className="status-label status-label--strong" style={{ '--c': 'var(--red)' } as React.CSSProperties}>
                                <Icon id="i-warning-fill" />
                                {t('memory.broken.title')}
                            </span>
                            <span className="info-card__mono selectable">{broken}</span>
                            <span className="info-card__body">{t('memory.broken.body')}</span>
                            {canOpenInCode && (
                                <div>
                                    <button className="button" onClick={() => openInCode(memoryPath)}>
                                        {t('memory.broken.open')}
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                ) : memory && lessons.length === 0 ? (
                    // Пустую память можно сразу наполнить из истории: замечания людей в прошлых PR и их ответы моделям
                    <div className="sheet__body" style={{ '--sheet-body': '300px' } as React.CSSProperties}>
                        <div className="info-card" style={{ gap: 'var(--space-12)' }}>
                            <div className="info-card__row" style={{ alignItems: 'center' }}>
                                <Icon id="i-history" className="icon info-card__icon" />
                                <div className="info-card__text">
                                    <span className="info-card__title">{t('memory.learn.title')}</span>
                                    <span className="info-card__body">{t('memory.learn.body')}</span>
                                </div>
                            </div>
                            <div className="info-card__controls">
                                {t('memory.learn.last')}
                                <div className="segmented" style={{ '--segment-width': '70px' } as React.CSSProperties}>
                                    {[50, 100, 300].map((count) => (
                                        <button key={count} className="segmented__item" aria-selected={historyPrs === count} disabled={jobs.learning} onClick={() => setHistoryPrs(count)}>
                                            {t('memory.learn.prs', { count })}
                                        </button>
                                    ))}
                                </div>
                                <span className="spacer" />
                                {jobs.learning ? (
                                    <span className="status-label" style={{ '--c': 'var(--label-2)' } as React.CSSProperties}>
                                        <Icon id="i-spinner" />
                                        {t('memory.learn.running')}
                                    </span>
                                ) : (
                                    <button className="button" onClick={learn}>
                                        {t('memory.learn.button')}
                                    </button>
                                )}
                            </div>
                            {jobs.learnResult && <span className="info-card__body selectable">{jobs.learnResult}</span>}
                            <span className="info-card__hint">{t('memory.learn.hint')}</span>
                        </div>
                    </div>
                ) : (
                    showsTabs && (
                        <>
                            <div className="sheet__bar">
                                <div className="segmented">
                                    <button className="segmented__item" aria-selected={tab === 'rules'} onClick={() => setTab('rules')}>
                                        {t('memory.tabs.rules', { count: lessons.length })}
                                    </button>
                                    <button className="segmented__item" aria-selected={tab === 'review'} onClick={() => setTab('review')}>
                                        {reviewing ? t('memory.tabs.reviewing') : t('memory.tabs.review')}
                                        {tab !== 'review' && plan && changes(plan) > 0 && <span className="segmented__count">{changes(plan)}</span>}
                                    </button>
                                    <button className="segmented__item" aria-selected={tab === 'history'} onClick={() => setTab('history')}>
                                        {t('memory.tabs.history')}
                                    </button>
                                </div>
                            </div>

                            {tab === 'rules' && (
                                <div className="sheet__body" style={{ '--sheet-body': '300px' } as React.CSSProperties}>
                                    <div className="section__card">
                                        {lessons.map((lesson, index) => (
                                            <div key={lesson.id}>
                                                {index > 0 && <div className="row-divider" />}
                                                {editing?.id === lesson.id ? (
                                                    <div className="lesson-editor">
                                                        <textarea
                                                            className="text-field text-field--multiline"
                                                            rows={Math.min(8, Math.max(2, editing.text.split('\n').length))}
                                                            value={editing.text}
                                                            autoFocus
                                                            onChange={(event) => setEditing({ id: lesson.id, text: event.target.value })}
                                                            onKeyDown={(event) => {
                                                                if (event.key === 'Enter' && !event.shiftKey) {
                                                                    event.preventDefault();
                                                                    save();
                                                                }
                                                                if (event.key === 'Escape') setEditing(null);
                                                            }}
                                                        />
                                                        <div className="lesson-editor__buttons">
                                                            <button className="button button--small" onClick={() => setEditing(null)}>
                                                                {t('common.action.cancel')}
                                                            </button>
                                                            <button className="button button--small button--prominent" disabled={!editing.text.trim()} onClick={save}>
                                                                {t('common.action.save')}
                                                            </button>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <div className="lesson">
                                                        <span className={`lesson__new${fresh.has(lesson.id) ? ' lesson__new--on' : ''}`} title={fresh.has(lesson.id) ? t('memory.lesson.fresh') : undefined} />
                                                        <div className="lesson__body">
                                                            <div className="lesson__text md selectable">
                                                                <Markdown text={lesson.text} />
                                                            </div>
                                                            <div className="lesson__meta">
                                                                {lesson.source?.url ? (
                                                                    <button className="link-button" onClick={() => openUrl(lesson.source!.url).catch(() => {})}>
                                                                        {origin(lesson)}
                                                                    </button>
                                                                ) : (
                                                                    <span>{origin(lesson)}</span>
                                                                )}
                                                                <span>· {ago(lesson.at)}</span>
                                                            </div>
                                                            {/* Срабатывания — только когда учёт уже начат */}
                                                            {memory?.since && (
                                                                <div className={`lesson__usage${idle(lesson.usage) ? ' lesson__usage--idle' : ''}`} title={t('memory.usage.hint')}>
                                                                    <Icon id="i-bolt" />
                                                                    {usageText(lesson.usage)}
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div className="lesson__actions">
                                                            <button className="icon-button" title={t('memory.lesson.edit')} onClick={() => setEditing({ id: lesson.id, text: lesson.text })}>
                                                                <Icon id="i-edit" />
                                                            </button>
                                                            <button className="icon-button" title={t('memory.lesson.remove')} onClick={() => remove(lesson.id)}>
                                                                <Icon id="i-trash" />
                                                            </button>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {tab === 'review' && (
                                <div className="sheet__body" style={{ '--sheet-body': '340px' } as React.CSSProperties}>
                                    {jobs.reviewError && <ErrorCard title={t('memory.review.failed')} text={jobs.reviewError} />}
                                    {reviewing ? (
                                        <div className="info-card">
                                            <div className="info-card__row">
                                                <Icon id="i-hourglass" className="icon hourglass lead-icon" style={{ '--c': 'var(--blue)' } as React.CSSProperties} />
                                                <div className="info-card__text">
                                                    <span className="status-label" style={{ '--c': 'var(--blue)' } as React.CSSProperties}>
                                                        {t('memory.review.running', { elapsed: elapsed(Math.max(0, Math.floor((now - (jobs.reviewing ?? now)) / 1000))) })}
                                                    </span>
                                                    <span className="info-card__body">{t('memory.review.runningHint')}</span>
                                                </div>
                                            </div>
                                        </div>
                                    ) : plan ? (
                                        <>
                                            <div className="plan-summary">
                                                <div className="plan-summary__meta">
                                                    {[t('memory.review.when', { ago: ago(plan.at) }), plan.usage?.costUsd != null ? `$${decimal(plan.usage.costUsd, 2)}` : null, t('memory.review.rules', counts(plan))].filter(Boolean).join(' · ')}
                                                </div>
                                                <div className="plan-summary__text md selectable">
                                                    <Markdown text={plan.summary} />
                                                </div>
                                                {plan.outdated && (
                                                    <span className="status-label" style={{ '--c': 'var(--orange)' } as React.CSSProperties}>
                                                        <Icon id="i-warning-fill" />
                                                        {t('memory.review.outdated')}
                                                    </span>
                                                )}
                                            </div>
                                            {GROUPS.map((type) => {
                                                const actions = plan.actions.filter((action) => action.type === type);
                                                if (!actions.length) return null;
                                                return (
                                                    <div key={type} className="section">
                                                        <div className="section__header">
                                                            {t(`memory.review.group.${type}`, { count: actions.length })}
                                                        </div>
                                                        <div className="section__card">
                                                            {actions.map((action, index) => (
                                                                <div key={index}>
                                                                    {index > 0 && <div className="row-divider" />}
                                                                    <div className="plan-action">
                                                                        <div className="plan-action__reason md">
                                                                            <Markdown text={action.reason} />
                                                                        </div>
                                                                        {action.type === 'drop' ? (
                                                                            action.ids.map((id) => (
                                                                                <div key={id} className="plan-action__dropped md">
                                                                                    <Markdown text={lessonText(id)} />
                                                                                </div>
                                                                            ))
                                                                        ) : (
                                                                            <Diff before={action.ids.map(lessonText)} after={action.text} />
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                            <div className="plan-kept">
                                                {changes(plan) === 0 ? t('memory.review.nothing') : t('memory.review.kept', { count: plan.actions.filter((action) => action.type === 'keep').reduce((total, action) => total + action.ids.length, 0) })}
                                            </div>
                                        </>
                                    ) : (
                                        <>
                                            {jobs.applied && <Done text={jobs.applied} />}
                                            <ReviewIntro />
                                        </>
                                    )}
                                </div>
                            )}

                            {tab === 'history' && (
                                <div className="sheet__body" style={{ '--sheet-body': '340px' } as React.CSSProperties}>
                                    {jobs.historyError && <ErrorCard title={t('memory.history.restoreFailed')} text={jobs.historyError} />}
                                    {jobs.restored && <Done text={jobs.restored} />}
                                    {!history.length && (
                                        <div className="info-card">
                                            <span className="info-card__body">{t('memory.history.empty')}</span>
                                        </div>
                                    )}
                                    {history.map((entry, index) => {
                                        const title = kindTitle(entry.kind);
                                        const color = KIND_COLORS[entry.kind] ?? null;
                                        return (
                                            <div key={`${entry.at}-${index}`} className="history-entry">
                                                <div className="history-entry__head">
                                                    <span className="tag" style={color ? ({ '--tag-color': color } as React.CSSProperties) : undefined}>
                                                        {title}
                                                    </span>
                                                    <span>{exactDate(entry.at)}</span>
                                                    {entry.pr != null && entry.url && (
                                                        <button className="link-button" title={t('memory.history.openPr')} onClick={() => openUrl(entry.url!).catch(() => {})}>
                                                            PR #{entry.pr}
                                                        </button>
                                                    )}
                                                    {entry.kind === 'review' &&
                                                        entry.at === restorable &&
                                                        (jobs.restoring ? (
                                                            <Icon id="i-spinner" />
                                                        ) : (
                                                            <button className="button button--small" title={t('memory.history.restoreHint')} onClick={restore}>
                                                                {t('memory.history.restore')}
                                                            </button>
                                                        ))}
                                                </div>
                                                {entry.reason && (
                                                    <div className="history-entry__reason md selectable">
                                                        <Markdown text={entry.reason} />
                                                    </div>
                                                )}
                                                {(entry.added ?? []).map((item, line) => (
                                                    <div key={`a${line}`} className="history-line md">
                                                        <Icon id="i-plus" className="icon history-line__icon" style={{ '--c': 'var(--green)' } as React.CSSProperties} />
                                                        <div className="history-line__body selectable">
                                                            <span>
                                                                <Markdown text={item.text} />
                                                            </span>
                                                        </div>
                                                    </div>
                                                ))}
                                                {(entry.removed ?? []).map((item, line) => (
                                                    <div key={`r${line}`} className="history-line md">
                                                        <Icon id="i-minus" className="icon history-line__icon" style={{ '--c': 'var(--red)' } as React.CSSProperties} />
                                                        <div className="history-line__body selectable">
                                                            <span className="history-line__removed">
                                                                <Markdown text={item.text} />
                                                            </span>
                                                            {item.reason && (
                                                                <span className="history-line__note">
                                                                    <Markdown text={item.reason} />
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                ))}
                                                {(entry.changed ?? []).map((change, line) => (
                                                    <div key={`c${line}`} className="history-line md">
                                                        <Icon id="i-edit" className="icon history-line__icon" style={{ '--c': 'var(--orange)' } as React.CSSProperties} />
                                                        <div className="history-line__body">
                                                            {change.reason && (
                                                                <span className="history-line__why">
                                                                    <Markdown text={change.reason} />
                                                                </span>
                                                            )}
                                                            <Diff before={[change.before]} after={change.after} />
                                                        </div>
                                                    </div>
                                                ))}
                                                {(entry.merged ?? []).map((merge, line) => (
                                                    <div key={`m${line}`} className="history-line md">
                                                        <Icon id="i-merge" className="icon history-line__icon" style={{ '--c': 'var(--purple)' } as React.CSSProperties} />
                                                        <div className="history-line__body">
                                                            {merge.reason && (
                                                                <span className="history-line__why">
                                                                    <Markdown text={merge.reason} />
                                                                </span>
                                                            )}
                                                            <Diff before={merge.from.map((item) => item.text)} after={merge.into.text} />
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </>
                    )
                )}
                {footer}
            </div>
        </div>
    );
};
