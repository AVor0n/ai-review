// Производные состояния обзора — перенос логики из menubar/Model.swift, OverviewView.swift и AgentIcons.swift
import { daysBetweenDates, parse } from './format';
import type { ArchState, Config, Data, FixState, PullRequest, QaState, Review, Status, TrackedFinding } from './types';

export const AGENT_ORDER = ['claude', 'codex', 'cursor'];
const STALL_MS = 15 * 60_000;
const TOKEN_WARNING_DAYS = 14;
// Atlassian и `claude setup-token` по умолчанию выпускают токены на год; у Cursor срок выбирается при выпуске
const DEFAULT_LIFETIME: Record<string, number> = { bitbucket: 365, claude: 365 };

export const agentIds = (config: Config) => {
    const rank = (id: string) => (AGENT_ORDER.includes(id) ? AGENT_ORDER.indexOf(id) : 99);
    return Object.keys(config.agents).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
};

export const agentName = (config: Config, id: string) => config.agents[id]?.shortName ?? id;

export const autoAgents = (config: Config) => agentIds(config).filter((id) => config.agents[id]?.auto !== false);

// Тот же шаблон, что у фонового ревью в review.mjs: остальные PR ревьюятся только вручную. По умолчанию — любой ключ задачи Jira
export const DEFAULT_BRANCH_PATTERN = '[A-Z][A-Z0-9]+-\\d+';
export const isTaskBranch = (config: Config, branch: string) => {
    try {
        return new RegExp(config.branchPattern ?? DEFAULT_BRANCH_PATTERN, 'i').test(branch);
    } catch {
        return false;
    }
};

export const isRunning = (status: Status | null) => status?.workerRunning === true;
export const isPaused = (status: Status | null) => status?.paused === true;

// Сервис до параллельных ревью писал только current
export const reviewsOf = (status: Status | null): Review[] => status?.running ?? (status?.current ? [status.current] : []);
export const runningReviews = (status: Status | null) => (isRunning(status) ? reviewsOf(status) : []);

export type Availability = { kind: 'available' } | { kind: 'manual' } | { kind: 'limit'; resetsAt: Date; updatedAt: Date | null };

// Исчерпанный лимит до сброса сам не восстанавливается, поэтому давность данных не важна — только что сброс впереди
export const availability = (data: Data, agent: string, now = new Date()): Availability => {
    const limit = data.limits[agent];
    const resetsAt = parse(limit?.resetsAt);
    if (limit && limit.usedPercent >= 100 && resetsAt && resetsAt > now) return { kind: 'limit', resetsAt, updatedAt: parse(limit.at) };
    return data.config.agents[agent]?.auto === false ? { kind: 'manual' } : { kind: 'available' };
};

const prState = (data: Data, repo: string, pr: number) => data.state.repos?.[repo]?.prs[String(pr)];

export const skipReason = (data: Data, repo: string, pr: PullRequest, agent: string) => {
    const mark = prState(data, repo, pr.id)?.skipped?.[agent];
    return mark && mark.head === pr.head ? mark.reason : null;
};

export type ReviewState = 'none' | 'stale' | 'done' | 'queued' | 'running';

export const reviewState = (data: Data, repo: string, pr: PullRequest, agent: string): ReviewState => {
    const match = (item: { repo: string; pr: number; agent: string }) => item.repo === repo && item.pr === pr.id && item.agent === agent;
    if (runningReviews(data.status).some(match)) return 'running';
    if (data.status?.queue.some(match)) return 'queued';
    const head = prState(data, repo, pr.id)?.reviewed[agent];
    if (!head) return 'none';
    return head === pr.head ? 'done' : 'stale';
};

export const importantFindings = (data: Data, repo: string, pr: number): TrackedFinding[] =>
    (prState(data, repo, pr)?.findings ?? []).filter((finding) => (finding.level === 'P0' || finding.level === 'P1') && finding.resolved !== true);

export const findingUrl = (pr: PullRequest, finding: TrackedFinding) => (finding.commentId ? `${pr.url}#comment-${finding.commentId}` : pr.url);

// Снимки до появления счётчика тредов: показываем число комментариев, как раньше
export const threads = (pr: PullRequest) => {
    const resolved = pr.resolvedThreads ?? 0;
    const total = pr.openThreads != null ? pr.openThreads + resolved : pr.commentCount;
    return { resolved, total, open: total - resolved, label: resolved > 0 ? `${resolved}/${total}` : `${total}` };
};

export const intervalMinutes = (config: Config) => config.intervalMinutes ?? 15;

export const nextPassAt = (data: Data, now = new Date()) => {
    if (isPaused(data.status) || isRunning(data.status)) return null;
    const last = parse(data.status?.lastPassAt);
    return last ? new Date(last.getTime() + intervalMinutes(data.config) * 60_000) : now;
};

const minutesUntil = (date: Date, now: Date) => Math.ceil((date.getTime() - now.getTime()) / 60_000);

export const headline = (data: Data, now = new Date()) => {
    const current = runningReviews(data.status)[0];
    if (current) return `Идёт ревью ${current.repo} #${current.pr} · ${agentName(data.config, current.agent)}`;
    if (isPaused(data.status)) return 'Фоновое ревью выключено';
    const next = nextPassAt(data, now);
    if (!next) return 'Ожидание';
    const minutes = minutesUntil(next, now);
    return minutes <= 1 ? 'Ожидание · проверка в течение минуты' : `Ожидание · следующая проверка через ${minutes} мин`;
};

// Проход завис, если сервис 15 минут не обновлял пульс: его останавливает только заблокированный процесс (git, сеть)
export const workerStall = (status: Status | null, now = new Date()) => {
    const beat = parse(status?.heartbeat);
    if (!isRunning(status) || !beat) return null;
    const idle = now.getTime() - beat.getTime();
    return idle > STALL_MS ? { since: beat, minutes: Math.floor(idle / 60_000) } : null;
};

// Состояние «идёт» без живого процесса — след прерванного запуска: показываем как сбой, чтобы кнопка не крутилась вечно
export const fixOf = (data: Data, repo: string, pr: number): FixState | null => {
    const fix = data.fixes.find((item) => item.repo === repo && item.pr === pr);
    if (!fix) return null;
    return fix.state === 'running' && !data.status?.workers.fix ? { ...fix, state: 'failed', step: null, activity: null, error: 'доработка прервана' } : fix;
};

export const archOf = (data: Data, repo: string, pr: number): ArchState | null => {
    const arch = data.archs.find((item) => item.repo === repo && item.pr === pr);
    if (!arch) return null;
    return arch.state === 'running' && !data.status?.workers.arch ? { ...arch, state: 'failed', activity: null, error: 'архитектурное ревью прервано' } : arch;
};

export const qaOf = (data: Data, repo: string, pr: number): QaState | null => {
    const qa = data.qas.find((item) => item.repo === repo && item.pr === pr);
    if (!qa) return null;
    const started = qa.state === 'planning' || qa.state === 'running';
    if (!started || data.status?.workers.qa) return qa;
    return { ...qa, state: qa.state === 'planning' ? 'plan-failed' : 'failed', error: 'тестирование прервано', step: null, activity: null };
};

export const isFixActive = (fix: FixState | null) => fix?.state === 'queued' || fix?.state === 'running';

// Треды, открытые сейчас, но появившиеся после доработки: её итог уже не закрывает все замечания PR
export const newThreads = (fix: FixState | null, pr: PullRequest) => {
    if (!fix || fix.state !== 'done' || fix.mode === 'rebase' || !fix.report) return 0;
    const seen = new Set(fix.report.seenIds ?? [...(fix.report.fixed ?? []), ...(fix.report.skipped ?? [])].map((item) => item.commentId));
    return (pr.openRoots ?? []).filter((thread) => !seen.has(thread.id)).length;
};

// Голова в отчёте и в снимке PR — первые 12 символов коммита, но длину не закладываем
export const isArchStale = (arch: ArchState | null, pr: PullRequest) => {
    const head = arch?.result?.head;
    if (!head || !pr.head) return false;
    return !(head.startsWith(pr.head) || pr.head.startsWith(head));
};

// Тестировать в браузере сервис умеет только фронтенд из qa.frontend; без qa.frontend и qa.backend тестирование выключено (qaRepoProblem в qa.mjs)
export const qaConfigured = (config: Config) => !!config.qa?.frontend && !!config.qa?.backend;
export const canTest = (config: Config, repo: string) => qaConfigured(config) && repo === config.qa?.frontend;

export const archAgentName = (config: Config) => agentName(config, config.arch?.agent ?? 'claude');

export const memoryLimit = (config: Config) => config.memory?.maxLessons ?? 60;

export type TokenInfo = { id: string; title: string; lifetimeDays: number | null; expiresAt: Date | null; daysLeft: number | null; isExpired: boolean; isExpiring: boolean };

export const tokens = (data: Data, now = new Date()): TokenInfo[] => {
    const { config } = data;
    const sources: { id: string; title: string; lifetime?: number }[] = [];
    if (config.bitbucket?.keychainService) sources.push({ id: 'bitbucket', title: 'Bitbucket', lifetime: config.bitbucket.tokenLifetimeDays });
    for (const id of ['claude', 'codex', 'cursor']) {
        const agent = config.agents[id];
        if (agent?.keychainService) sources.push({ id, title: agent.shortName, lifetime: agent.tokenLifetimeDays });
    }
    return sources.map(({ id, title, lifetime }) => {
        const lifetimeDays = lifetime ?? DEFAULT_LIFETIME[id] ?? null;
        const savedAt = parse(data.secrets.find((secret) => secret.id === id)?.savedAt);
        const expiresAt = savedAt && lifetimeDays ? new Date(savedAt.getFullYear(), savedAt.getMonth(), savedAt.getDate() + lifetimeDays, savedAt.getHours(), savedAt.getMinutes()) : null;
        const daysLeft = expiresAt ? daysBetweenDates(now, expiresAt) : null;
        return { id, title, lifetimeDays, expiresAt, daysLeft, isExpired: expiresAt ? expiresAt <= now : false, isExpiring: daysLeft !== null && daysLeft <= TOKEN_WARNING_DAYS };
    });
};

// Открытые PR, текущий коммит которых ещё не проверила хотя бы одна модель фонового ревью.
// Черновики, ветки не по задачам и репозитории на паузе фон не ревьюит — их не считаем, иначе число никогда бы не обнулялось
export const unreviewedPrs = (data: Data) => {
    const agents = autoAgents(data.config);
    if (!agents.length) return 0;
    return data.config.repos
        .filter((repo) => !repo.paused)
        .reduce((total, repo) => {
            const prs = (data.snapshots[repo.slug]?.prs ?? []).filter((pr) => !pr.draft && isTaskBranch(data.config, pr.source));
            return total + prs.filter((pr) => agents.some((agent) => prState(data, repo.slug, pr.id)?.reviewed[agent] !== pr.head)).length;
        }, 0);
};

export const waitingImportant = (data: Data) =>
    Object.entries(data.state.repos ?? {}).reduce((total, [repo, repoState]) => {
        const open = new Set((data.snapshots[repo]?.prs ?? []).map((pr) => String(pr.id)));
        return total + Object.entries(repoState.prs).filter(([id]) => open.has(id)).flatMap(([, pr]) => pr.findings ?? []).filter((finding) => (finding.level === 'P0' || finding.level === 'P1') && finding.resolved !== true).length;
    }, 0);
