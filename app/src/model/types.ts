// Данные сервиса так, как их отдаёт API (файлы данных как есть). Поля — как в menubar/Model.swift
export type Review = { repo: string; pr: number; agent: string; role: string; title?: string | null };

export type Status = {
    phase?: string | null;
    current?: Review | null;
    running?: Review[] | null;
    lastRunAt?: string | null;
    lastPassAt?: string | null;
    lastError?: string | null;
    errorStreak?: number | null;
    paused: boolean;
    workerRunning: boolean;
    heartbeat: string | null;
    queue: { repo: string; pr: number; agent: string }[];
    workers: { fix: boolean; arch: boolean; qa: boolean };
};

export type AgentConfig = { shortName: string; auto?: boolean; keychainService?: string; tokenLifetimeDays?: number; model?: string; effort?: string; reasoningEffort?: string };
export type RepoConfig = { workspace: string; slug: string; paused?: boolean; remote?: string; source?: string };

export type Config = {
    repos: RepoConfig[];
    agents: Record<string, AgentConfig>;
    intervalMinutes?: number;
    memory?: { maxLessons?: number };
    branchPattern?: string;
    ignorePaths?: string[];
    bitbucket?: { keychainService?: string; tokenLifetimeDays?: number; email?: string };
    arch?: { agent?: string };
    qa?: { frontend?: string; backend?: string };
    displayPrefix?: string;
    language?: 'system' | 'ru' | 'en';
};

export type OpenThread = { id: number };

export type PullRequest = {
    id: number;
    title: string;
    draft: boolean;
    author?: string | null;
    updatedOn?: string | null;
    commentCount: number;
    openThreads?: number | null;
    resolvedThreads?: number | null;
    url: string;
    head: string;
    source: string;
    destination: string;
    behind?: number | null;
    conflicts?: boolean | null;
    openRoots?: OpenThread[] | null;
};

export type PrSnapshot = { fetchedAt: string; prs: PullRequest[] };

export type TrackedFinding = { commentId?: number | null; agent: string; level: string; title: string; at: string; resolved?: boolean | null };

export type PrState = {
    reviewed: Record<string, string>;
    findings?: TrackedFinding[];
    skipped?: Record<string, { head: string; reason: string }>;
};

export type WorkerState = { repos?: Record<string, { prs: Record<string, PrState> }> };

export type Limit = { usedPercent: number; window?: string; resetsAt?: string | null; at?: string | null; error?: { code?: number | null; text: string } | null; errorAt?: string | null };

export type FixState = {
    repo: string;
    pr: number;
    state: string;
    step?: string | null;
    error?: string | null;
    activity?: string | null;
    mode?: string | null;
    report?: { message: string; seenIds?: number[]; fixed?: { commentId: number }[]; skipped?: { commentId: number }[] } | null;
};

export type ArchState = { repo: string; pr: number; state: string; activity?: string | null; error?: string | null; result?: { head: string; report: { verdict: string } } | null };

export type QaState = {
    repo: string;
    pr: number;
    state: string;
    step?: string | null;
    activity?: string | null;
    error?: string | null;
    plan?: { cases: unknown[] } | null;
    run?: { cases: { status?: string }[] } | null;
};

export type Lesson = { id: string; text: string; at: string; manual?: boolean };

export type Secret = { id: string; service?: string; account?: string | null; present: boolean; savedAt: string | null };

export type Data = {
    status: Status | null;
    config: Config;
    snapshots: Record<string, PrSnapshot | null>;
    state: WorkerState;
    limits: Record<string, Limit>;
    fixes: FixState[];
    archs: ArchState[];
    qas: QaState[];
    memory: Record<string, Lesson[]>;
    secrets: Secret[];
};

export const emptyData = (): Data => ({ status: null, config: { repos: [], agents: {} }, snapshots: {}, state: {}, limits: {}, fixes: [], archs: [], qas: [], memory: {}, secrets: [] });
