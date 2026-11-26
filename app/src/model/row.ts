// Строка PR и капсулы шапки: иконки, цвета и подсказки — как AgentReviewButton, AvailabilityCapsule,
// FixButton, ArchButton и QaButton в SwiftUI. Цвет — модификатор класса из agents/design/web/components.css
import {
    agentIds,
    agentName,
    archAgentName,
    archOf,
    autoAgents,
    availability,
    fixOf,
    isArchStale,
    isFixActive,
    isPaused,
    isRunning,
    isTaskBranch,
    newThreads,
    nextPassAt,
    qaOf,
    reviewState,
    skipReason,
    threads,
    type Availability,
    type ReviewState,
} from './derive';
import { ago, fullDate, parse, resetFull, resetShort } from './format';
import type { Data, PullRequest } from './types';
import { t } from '../i18n';

export type ModelButton = { agent: string; state: ReviewState; badge: 'limit' | 'manual' | null; hint: string; busy: boolean };

export const modelHint = (name: string, state: ReviewState, available: Availability, skip: string | null) => {
    // У лимита нет «Нажмите, чтобы запустить»: запуск упрётся в лимит, но кнопка работает — данные о лимите могут устареть
    if ((state === 'none' || state === 'stale') && available.kind === 'limit') return t('overview.model.limit', { name, reset: resetShort(available.resetsAt) });
    if (state === 'none' && available.kind === 'manual') return t('overview.model.manualNone', { name });
    if (state === 'stale' && available.kind === 'manual') return t('overview.model.manualStale', { name });
    if (state === 'done' && skip === 'rebase') return t('overview.model.rebase', { name });
    if (state === 'done' && skip === 'ignored') return t('overview.model.ignored', { name });
    if (state === 'done' && skip === 'empty') return t('overview.model.empty', { name });
    const base = t(`overview.model.${state}`, { name });
    return available.kind === 'manual' ? t('overview.model.manualSuffix', { hint: base }) : base;
};

const repoPaused = (data: Data, repo: string) => data.config.repos.some((item) => item.slug === repo && item.paused);

export const modelButtons = (data: Data, repo: string, pr: PullRequest, now = new Date()): ModelButton[] =>
    agentIds(data.config).map((agent) => {
        const state = reviewState(data, repo, pr, agent);
        const available = availability(data, agent, now);
        // При выключенном фоновом ревью вручную запускаются все модели, и пометка «только вручную» ничего не говорит
        const showsManual = !isPaused(data.status) && !repoPaused(data, repo);
        const badge = available.kind === 'limit' ? 'limit' : available.kind === 'manual' && showsManual ? 'manual' : null;
        return { agent, state, badge, busy: state === 'queued' || state === 'running', hint: modelHint(agentName(data.config, agent), state, available, skipReason(data, repo, pr, agent)) };
    });

export type Capsule = { agent: string; limited: boolean; text: string; hint: string };

// Сначала лимит, потом «только вручную»; при выключенном фоновом ревью вручную работают все модели
export const capsules = (data: Data, now = new Date()): Capsule[] => {
    const states = agentIds(data.config).map((agent) => ({ agent, name: agentName(data.config, agent), available: availability(data, agent, now) }));
    const limited = states.filter((item) => item.available.kind === 'limit');
    const manual = isPaused(data.status) ? [] : states.filter((item) => item.available.kind === 'manual');
    return [...limited, ...manual].map(({ agent, name, available }) =>
        available.kind === 'limit'
            ? {
                  agent,
                  limited: true,
                  text: t('overview.capsule.limit', { name, reset: resetShort(available.resetsAt, now) }),
                  hint: available.updatedAt
                      ? t('overview.capsule.limitHintUpdated', { name, reset: resetFull(available.resetsAt), time: ago(available.updatedAt, now) })
                      : t('overview.capsule.limitHint', { name, reset: resetFull(available.resetsAt) }),
              }
            : { agent, limited: false, text: t('overview.capsule.manual', { name }), hint: t('overview.capsule.manualHint', { name }) },
    );
};

export type Threads = { kind: 'clean' | 'resolved' | 'none' | 'open'; label: string; hint: string };

export const threadsCounter = (data: Data, repo: string, pr: PullRequest, now = new Date()): Threads => {
    const counts = threads(pr);
    const auto = autoAgents(data.config);
    // Модели только для ручного запуска не в счёт; без фоновых моделей галочку ставить не на чем
    const clean = counts.total === 0 && auto.length > 0 && auto.every((agent) => reviewState(data, repo, pr, agent) === 'done');
    if (clean) {
        // Пропуск без ревью голова тоже считает проверенной: галочка не должна выдавать его за чистое ревью
        const reasons = auto.map((agent) => skipReason(data, repo, pr, agent));
        const hint = t(reasons.includes('ignored') ? 'overview.threads.ignored' : reasons.includes('empty') ? 'overview.threads.empty' : 'overview.threads.clean');
        return { kind: 'clean', label: '', hint };
    }
    if (counts.total === 0) return { kind: 'none', label: counts.label, hint: noReviewHint(data, repo, pr, now) };
    return {
        kind: counts.resolved === counts.total ? 'resolved' : 'open',
        label: counts.label,
        hint: t('overview.threads.counts', { resolved: counts.resolved, total: counts.total, comments: pr.commentCount }),
    };
};

const noReviewHint = (data: Data, repo: string, pr: PullRequest, now: Date) => {
    if (isPaused(data.status)) return t('overview.noReview.paused');
    if (repoPaused(data, repo)) return t('overview.noReview.repoPaused');
    if (pr.draft) return t('overview.noReview.draft');
    if (!isTaskBranch(data.config, pr.source)) return t('overview.noReview.untracked');
    const auto = autoAgents(data.config);
    if (!auto.length) return t('overview.noReview.allManual');
    if (auto.every((agent) => availability(data, agent, now).kind === 'limit')) return t('overview.noReview.allLimited');
    if (isRunning(data.status)) return t('overview.noReview.running');
    const next = nextPassAt(data, now);
    if (!next) return t('overview.noReview.waiting');
    const minutes = Math.ceil((next.getTime() - now.getTime()) / 60_000);
    return minutes <= 1 ? t('overview.noReview.soon') : t('overview.noReview.next', { minutes });
};

export type ActionColor = 'green' | 'yellow' | 'orange' | 'red' | 'accent' | null;
export type RowAction = { icon: string; spinner: boolean; color: ActionColor; stale: boolean; disabled: boolean; hint: string };

// Тестирование, пока не заданы репозитории QA: приглушённая кнопка ведёт в config.json
export const qaOff = (): RowAction => ({ icon: 'i-qa', spinner: false, color: null, stale: true, disabled: false, hint: t('overview.qa.off') });

// Что делает клик: start — подтверждение запуска, report — отчёт и ход (заглушка), none — кнопка выключена
export type FixAction = RowAction & { click: 'start-fix' | 'start-rebase' | 'report' | 'none' };

const lastLine = (text: string | null | undefined) => text?.split('\n').filter(Boolean).pop() ?? '';

// Шаг и действие приходят из сервиса как есть
const progress = (step: string | null | undefined, activity: string | null | undefined) => `${step ?? '…'}${activity ? ` — ${activity}` : ''}`;

export const fixAction = (data: Data, repo: string, pr: PullRequest): FixAction => {
    const fix = fixOf(data, repo, pr.id);
    const { open } = threads(pr);
    const behind = pr.behind ?? 0;
    const conflicts = pr.conflicts === true;
    // Что можно запустить сейчас: null — нечего, false — Fix, true — Rebase
    const available = open > 0 ? false : behind > 0 ? true : null;
    // Итог прошлого запуска показываем, пока не стало доступно другое действие: иначе после Fix нельзя было бы сделать Rebase
    const showsState = !!fix && (isFixActive(fix) || available === null || available === (fix.mode === 'rebase'));
    const rebase = showsState ? fix?.mode === 'rebase' : available === true;
    const state = showsState ? fix?.state : undefined;
    const fresh = newThreads(fix, pr);
    const name = t(rebase ? 'overview.fix.nameRebase' : 'overview.fix.nameFix');
    const icon = state === 'queued' ? 'i-clock' : state === 'done' ? 'i-check-circle' : state === 'failed' ? 'i-warning' : rebase ? 'i-rebase' : 'i-fix';
    const color: ActionColor =
        state === 'done' ? (fresh > 0 ? 'yellow' : 'green') : state === 'failed' ? 'orange' : !state && rebase && conflicts && (showsState || available !== null) ? 'orange' : null;
    const result = fix?.report?.message ?? t('overview.fix.ready');
    const hint =
        state === 'queued'
            ? t('overview.fix.queued', { name })
            : state === 'running'
              ? t('overview.fix.running', { name, progress: progress(fix?.step, fix?.activity) })
              : state === 'done' && fresh > 0
                ? t('overview.fix.doneFresh', { name, result, count: fresh })
                : state === 'done'
                  ? t('overview.fix.done', { name, result })
                  : state === 'failed'
                    ? t('overview.fix.failed', { name, error: lastLine(fix?.error) })
                    : rebase
                      ? t(conflicts ? 'overview.fix.behindConflicts' : 'overview.fix.behind', { count: behind })
                      : available === null
                        ? t('overview.fix.nothing')
                        : t('overview.fix.start', { count: open });
    return {
        icon,
        spinner: isFixActive(fix) && state === 'running',
        color,
        stale: false,
        disabled: !showsState && available === null,
        hint,
        click: showsState ? 'report' : available === null ? 'none' : available ? 'start-rebase' : 'start-fix',
    };
};

const VERDICT_COLORS: Record<string, ActionColor> = { keep: 'green', discuss: 'yellow', rework: 'orange' };

const verdictOf = (verdict: string) =>
    verdict === 'keep' || verdict === 'discuss' || verdict === 'rework' ? { title: t(`overview.arch.verdict.${verdict}`), color: VERDICT_COLORS[verdict] } : { title: verdict, color: null };

export const archAction = (data: Data, repo: string, pr: PullRequest): RowAction & { click: 'start' | 'report' } => {
    const arch = archOf(data, repo, pr.id);
    const stale = isArchStale(arch, pr);
    const verdict = arch?.result ? verdictOf(arch.result.report.verdict) : null;
    const state = arch?.state;
    const icon = state === 'queued' ? 'i-clock' : state === 'failed' ? 'i-warning' : state === 'done' ? 'i-arch-fill' : 'i-arch';
    const color: ActionColor = state === 'failed' ? 'orange' : state === 'done' ? (verdict?.color ?? null) : null;
    const verdictText = verdict?.title.toLowerCase() ?? t('overview.arch.ready');
    const hint =
        state === 'queued'
            ? t('overview.arch.queued')
            : state === 'running'
              ? arch?.activity
                  ? t('overview.arch.runningActivity', { activity: arch.activity })
                  : t('overview.arch.running')
              : state === 'failed'
                ? t('overview.arch.failed', { error: lastLine(arch?.error) })
                : state === 'done'
                  ? t(stale ? 'overview.arch.doneStale' : 'overview.arch.done', { verdict: verdictText })
                  : t('overview.arch.idle', { model: archAgentName(data.config) });
    return { icon, spinner: state === 'running', color, stale: state === 'done' && stale, disabled: false, hint, click: arch ? 'report' : 'start' };
};

const QA_ORDER = ['failed', 'unconfirmed', 'blocked', 'passed', 'skipped'] as const;

export const qaAction = (data: Data, repo: string, pr: PullRequest): RowAction => {
    const qa = qaOf(data, repo, pr.id);
    const state = qa?.state;
    const count = (status: string) => qa?.run?.cases.filter((item) => (item.status ?? 'unconfirmed') === status).length ?? 0;
    const error = lastLine(qa?.error);
    const icon = state === 'planning-queued' || state === 'run-queued' ? 'i-clock' : state === 'plan-failed' || state === 'failed' ? 'i-warning' : 'i-qa';
    const runColor: ActionColor = count('failed') > 0 ? 'red' : count('unconfirmed') + count('blocked') > 0 ? 'orange' : 'green';
    const color: ActionColor = state === 'planned' ? 'accent' : state === 'plan-failed' || state === 'failed' ? 'orange' : state === 'done' ? (qa?.run ? runColor : null) : null;
    const cases = qa?.plan?.cases.length ?? 0;
    const hint =
        state === 'planning-queued'
            ? t('overview.qa.planningQueued')
            : state === 'planning'
              ? qa?.activity
                  ? t('overview.qa.planningActivity', { activity: qa.activity })
                  : t('overview.qa.planning')
              : state === 'planned'
                ? t('overview.qa.planned', { count: cases })
                : state === 'plan-failed'
                  ? t('overview.qa.planFailed', { error })
                  : state === 'run-queued'
                    ? t('overview.qa.runQueued')
                    : state === 'running'
                      ? t('overview.qa.running', { progress: progress(qa?.step, qa?.activity) })
                      : state === 'failed'
                        ? t('overview.qa.failed', { error })
                        : state === 'done'
                          ? qa?.run
                              ? t('overview.qa.done', {
                                    summary: QA_ORDER.filter((status) => count(status) > 0)
                                        .map((status) => t('overview.qa.statusCount', { status: t(`overview.qa.status.${status}`), count: count(status) }))
                                        .join(', '),
                                })
                              : t('overview.qa.doneEmpty')
                          : t('overview.qa.idle');
    return { icon, spinner: state === 'planning' || state === 'running', color, stale: false, disabled: false, hint };
};

export const updatedText = (pr: PullRequest, now = new Date()) => {
    const date = parse(pr.updatedOn);
    return { text: ago(pr.updatedOn, now), hint: t('overview.row.updated', { date: date ? fullDate(date) : '—' }) };
};

// Черновики уходят вниз и приглушаются: фоновое ревью их пропускает, и они только отвлекают.
// Ветки не по задачам остаются на месте с тегом: такой PR часто хочется посмотреть вручную
export const sortedPrs = (prs: PullRequest[]) => [...prs].sort((a, b) => (a.draft !== b.draft ? (a.draft ? 1 : -1) : (b.updatedOn ?? '').localeCompare(a.updatedOn ?? '')));
