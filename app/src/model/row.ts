// Строка PR и капсулы шапки: иконки, цвета и подсказки — как AgentReviewButton, AvailabilityCapsule,
// FixButton, ArchButton и QaButton в SwiftUI. Цвет — модификатор класса из product/design/web/components.css
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
import { ago, fullDate, parse, plural, resetFull, resetShort } from './format';
import type { Data, PullRequest } from './types';

export type ModelButton = { agent: string; state: ReviewState; badge: 'limit' | 'manual' | null; hint: string; busy: boolean };

export const modelHint = (name: string, state: ReviewState, available: Availability, skip: string | null) => {
    // У лимита нет «Нажмите, чтобы запустить»: запуск упрётся в лимит, но кнопка работает — данные о лимите могут устареть
    if ((state === 'none' || state === 'stale') && available.kind === 'limit') return `${name}: лимит исчерпан ${resetShort(available.resetsAt)} — ревью будет после сброса`;
    if (state === 'none' && available.kind === 'manual') return `${name}: ревью не было — модель только для ручного запуска. Нажмите, чтобы запустить`;
    if (state === 'stale' && available.kind === 'manual') return `${name}: ревью было на старом коммите, в фоне модель не запускается. Нажмите, чтобы проверить новый`;
    if (state === 'done' && skip === 'rebase') return `${name}: повторное ревью не нужно — после rebase изменения те же. Нажмите, чтобы проверить заново`;
    if (state === 'done' && skip === 'ignored') return `${name}: ревью не понадобилось — в диффе только исключённые файлы. Нажмите, чтобы проверить заново`;
    if (state === 'done' && skip === 'empty') return `${name}: ревью не понадобилось — в PR нет изменений относительно целевой ветки. Нажмите, чтобы проверить заново`;
    const base = {
        none: `${name}: ревью не было. Нажмите, чтобы запустить`,
        stale: `${name}: ревью было на старом коммите. Нажмите, чтобы проверить новый`,
        done: `${name}: ревью актуально. Нажмите, чтобы проверить заново`,
        queued: `${name}: ревью в очереди`,
        running: `${name}: идёт ревью`,
    }[state];
    return available.kind === 'manual' ? `${base}. В фоне эта модель не запускается` : base;
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
                  text: `${name}: лимит ${resetShort(available.resetsAt, now)}`,
                  hint: `${name} исчерпал лимит, сброс ${resetFull(available.resetsAt)}. После сброса модель снова начнёт ревью сама${available.updatedAt ? `. Обновлено ${ago(available.updatedAt, now)}` : ''}`,
              }
            : { agent, limited: false, text: `${name}: только вручную`, hint: `${name} не участвует в фоновом ревью и запускается только по клику на значок. Включить — Настройки → Модели` },
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
        const hint = reasons.includes('ignored')
            ? 'Ревью не понадобилось: в диффе только исключённые файлы'
            : reasons.includes('empty')
              ? 'Ревью не понадобилось: в PR нет изменений относительно целевой ветки'
              : 'Модели проверили последний коммит и замечаний не нашли';
        return { kind: 'clean', label: '', hint };
    }
    if (counts.total === 0) return { kind: 'none', label: counts.label, hint: noReviewHint(data, repo, pr, now) };
    return {
        kind: counts.resolved === counts.total ? 'resolved' : 'open',
        label: counts.label,
        hint: `Тредов закрыто ${counts.resolved} из ${counts.total}, всего комментариев ${pr.commentCount}`,
    };
};

const noReviewHint = (data: Data, repo: string, pr: PullRequest, now: Date) => {
    const manual = 'Запустить можно по значку модели';
    if (isPaused(data.status)) return `Фоновое ревью выключено. ${manual}`;
    if (repoPaused(data, repo)) return `Фоновое ревью репозитория выключено. ${manual}`;
    if (pr.draft) return `Черновик — фоновое ревью черновики пропускает. ${manual}`;
    if (!isTaskBranch(data.config, pr.source)) return `Ветка вне шаблона веток задач — фоновое ревью её пропускает. ${manual}`;
    const auto = autoAgents(data.config);
    if (!auto.length) return `Все модели запускаются только вручную — фоновое ревью этот PR не возьмёт. ${manual}`;
    if (auto.every((agent) => availability(data, agent, now).kind === 'limit')) return 'Все фоновые модели упёрлись в лимит. Ревью будет после сброса';
    if (isRunning(data.status)) return 'Ревью ещё не было: идёт проход';
    const next = nextPassAt(data, now);
    if (!next) return 'Ревью ещё не было: ждёт прохода';
    const minutes = Math.ceil((next.getTime() - now.getTime()) / 60_000);
    return minutes <= 1 ? 'Ревью ещё не было: ждёт прохода, следующий в течение минуты' : `Ревью ещё не было: ждёт прохода, следующий через ${minutes} мин`;
};

export type ActionColor = 'green' | 'yellow' | 'orange' | 'red' | 'accent' | null;
export type RowAction = { icon: string; spinner: boolean; color: ActionColor; stale: boolean; disabled: boolean; hint: string };

// Тестирование, пока не заданы репозитории QA: приглушённая кнопка ведёт в config.json
export const QA_OFF: RowAction = { icon: 'i-qa', spinner: false, color: null, stale: true, disabled: false, hint: 'Тестирование не настроено: укажите qa.frontend и qa.backend в config.json. Нажмите, чтобы открыть его' };

// Что делает клик: start — подтверждение запуска, report — отчёт и ход (заглушка), none — кнопка выключена
export type FixAction = RowAction & { click: 'start-fix' | 'start-rebase' | 'report' | 'none' };

const lastLine = (text: string | null | undefined) => text?.split('\n').filter(Boolean).pop() ?? '';

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
    const name = rebase ? 'Rebase' : 'Доработка';
    const icon = state === 'queued' ? 'i-clock' : state === 'done' ? 'i-check-circle' : state === 'failed' ? 'i-warning' : rebase ? 'i-rebase' : 'i-fix';
    const color: ActionColor =
        state === 'done' ? (fresh > 0 ? 'yellow' : 'green') : state === 'failed' ? 'orange' : !state && rebase && conflicts && (showsState || available !== null) ? 'orange' : null;
    const hint =
        state === 'queued'
            ? `${name} в очереди`
            : state === 'running'
              ? `${name} идёт: ${fix?.step ?? '…'}${fix?.activity ? ` — ${fix.activity}` : ''}. Нажмите, чтобы посмотреть ход или прервать`
              : state === 'done' && fresh > 0
                ? `${name}: ${fix?.report?.message ?? 'готово'}, но после неё появились новые замечания (${fresh}). Нажмите, чтобы посмотреть их и запустить доработку снова`
                : state === 'done'
                  ? `${name}: ${fix?.report?.message ?? 'готово'}. Нажмите, чтобы посмотреть отчёт`
                  : state === 'failed'
                    ? `${name} не удалась: ${lastLine(fix?.error)}. Нажмите, чтобы посмотреть отчёт`
                    : rebase
                      ? `Ветка отстала от базы на ${behind} коммит(ов)${conflicts ? ', будут конфликты — их разрешит Claude' : ''} — rebase, проверки и push`
                      : available === null
                        ? 'Открытых замечаний нет, ветка на свежей базе'
                        : `Исправить открытые замечания (${open}) — Claude: rebase, правки, коммит, проверки и push`;
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

const VERDICTS: Record<string, { title: string; color: ActionColor }> = {
    keep: { title: 'Оставить как есть', color: 'green' },
    discuss: { title: 'Стоит обсудить', color: 'yellow' },
    rework: { title: 'Лучше переделать', color: 'orange' },
};

export const archAction = (data: Data, repo: string, pr: PullRequest): RowAction & { click: 'start' | 'report' } => {
    const arch = archOf(data, repo, pr.id);
    const stale = isArchStale(arch, pr);
    const verdict = arch?.result ? (VERDICTS[arch.result.report.verdict] ?? { title: arch.result.report.verdict, color: null }) : null;
    const state = arch?.state;
    const icon = state === 'queued' ? 'i-clock' : state === 'failed' ? 'i-warning' : state === 'done' ? 'i-arch-fill' : 'i-arch';
    const color: ActionColor = state === 'failed' ? 'orange' : state === 'done' ? (verdict?.color ?? null) : null;
    const hint =
        state === 'queued'
            ? 'Архитектурное ревью в очереди. Нажмите, чтобы посмотреть'
            : state === 'running'
              ? `Идёт архитектурное ревью${arch?.activity ? `: ${arch.activity}` : ''}. Нажмите, чтобы посмотреть ход или прервать`
              : state === 'failed'
                ? `Архитектурное ревью не удалось: ${lastLine(arch?.error)}. Нажмите, чтобы посмотреть`
                : state === 'done'
                  ? stale
                      ? `Архитектурное ревью: ${verdict?.title.toLowerCase() ?? 'готово'}. Отчёт снят на старом коммите — нажмите, чтобы посмотреть и перезапустить`
                      : `Архитектурное ревью: ${verdict?.title.toLowerCase() ?? 'готово'}. Нажмите, чтобы посмотреть отчёт`
                  : `Архитектурное ревью — ${archAgentName(data.config)} оценит цель, альтернативы, где можно проще и риски. Отчёт только здесь, в PR не публикуется`;
    return { icon, spinner: state === 'running', color, stale: state === 'done' && stale, disabled: false, hint, click: arch ? 'report' : 'start' };
};

const QA_STATUS: Record<string, string> = { failed: 'ошибка приложения', unconfirmed: 'не подтверждено', blocked: 'не удалось проверить', passed: 'прошло', skipped: 'пропущено' };
const QA_ORDER = ['failed', 'unconfirmed', 'blocked', 'passed', 'skipped'];

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
            ? 'План тестирования в очереди'
            : state === 'planning'
              ? `Составляется план тестирования${qa?.activity ? `: ${qa.activity}` : ''}. Нажмите, чтобы посмотреть`
              : state === 'planned'
                ? `План тестирования готов: ${cases} ${plural(cases, 'кейс', 'кейса', 'кейсов')}. Нажмите, чтобы выбрать кейсы и запустить прогон`
                : state === 'plan-failed'
                  ? `План тестирования не удался: ${error}. Нажмите, чтобы посмотреть`
                  : state === 'run-queued'
                    ? 'Прогон в очереди'
                    : state === 'running'
                      ? `Идёт прогон: ${qa?.step ?? '…'}${qa?.activity ? ` — ${qa.activity}` : ''}. Нажмите, чтобы посмотреть ход или прервать`
                      : state === 'failed'
                        ? `Прогон не удался: ${error}. Нажмите, чтобы посмотреть`
                        : state === 'done'
                          ? qa?.run
                              ? `Прогон готов: ${QA_ORDER.filter((status) => count(status) > 0)
                                    .map((status) => `${QA_STATUS[status]} — ${count(status)}`)
                                    .join(', ')}. Нажмите, чтобы посмотреть отчёт`
                              : 'Прогон готов'
                          : 'Тестирование PR: Claude составит план — юнит, компонентные и e2e-кейсы, а после вашего выбора напишет и прогонит тесты (e2e — в Playwright на локальном бэкенде). Тесты можно сохранить в репозиторий, в PR ничего не публикуется';
    return { icon, spinner: state === 'planning' || state === 'running', color, stale: false, disabled: false, hint };
};

export const updatedText = (pr: PullRequest, now = new Date()) => {
    const date = parse(pr.updatedOn);
    return { text: ago(pr.updatedOn, now), hint: `Обновлён ${date ? fullDate(date) : '—'}` };
};

// Черновики уходят вниз и приглушаются: фоновое ревью их пропускает, и они только отвлекают.
// Ветки не по задачам остаются на месте с тегом: такой PR часто хочется посмотреть вручную
export const sortedPrs = (prs: PullRequest[]) => [...prs].sort((a, b) => (a.draft !== b.draft ? (a.draft ? 1 : -1) : (b.updatedOn ?? '').localeCompare(a.updatedOn ?? '')));
