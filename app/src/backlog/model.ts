import { t } from '../i18n';
import { ago, formatDate, parse } from '../model/format';
import type { Config } from '../model/types';

// Записи бэклога, задача разбора и сбор из истории — как BacklogItem, BacklogJob, BacklogScan в menubar/Model.swift
export type BacklogSource = { pr: number; url: string; agent: string; commit?: string | null; kind?: string | null; at?: string | null; author?: string | null };
export type BacklogTriage = { at: string; commit?: string | null; branch?: string | null; verdict: string; reason: string };
export type BacklogItem = {
    id: string;
    repo: string;
    status: string;
    level: string;
    likelihood?: string | null;
    path?: string | null;
    line?: number | null;
    title: string;
    scenario?: string | null;
    fix?: string | null;
    ticket?: string | null;
    note?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
    sources: BacklogSource[];
    triage?: BacklogTriage | null;
};
export type BacklogJob = { kind: string; state: string; running?: boolean; activity?: string | null; startedAt?: string | null; finishedAt?: string | null; message?: string | null; error?: string | null };
export type BacklogScan = { repos: Record<string, { at?: string | null; found?: number | null }> };

const LEVELS = ['P0', 'P1', 'P2', 'P3'];
const STALE = ['fixed', 'gone', 'invalid'];
const TRIAGE_ICONS: Record<string, string> = { fixed: 'i-check-circle', gone: 'i-trash', invalid: 'i-x-circle', actual: 'i-warning-circle' };

export const isOpen = (item: BacklogItem) => item.status === 'open';
export const isStaleVerdict = (triage: BacklogTriage) => STALE.includes(triage.verdict);
export const isStale = (item: BacklogItem) => isOpen(item) && !!item.triage && isStaleVerdict(item.triage);
export const triageTitle = ({ verdict }: BacklogTriage) =>
    t(verdict === 'actual' || verdict === 'fixed' || verdict === 'gone' || verdict === 'invalid' ? `backlog.triage.verdict.${verdict}` : 'backlog.triage.verdict.unknown');
export const triageIcon = (triage: BacklogTriage) => TRIAGE_ICONS[triage.verdict] ?? 'i-question';
export const likelihoodTitle = ({ likelihood }: BacklogItem) => (likelihood === 'rare' || likelihood === 'race' ? t(`backlog.likelihood.${likelihood}`) : null);
export const jobTitle = (job: BacklogJob) => t(job.kind === 'learn' ? 'backlog.job.learn' : 'backlog.job.triage');
export const sourceKind = ({ kind }: BacklogSource) => t(kind === 'history' || kind === 'reply' || kind === 'deferred' ? `backlog.source.${kind}` : 'backlog.source.review');
export const location = (item: BacklogItem) => (item.path ? (item.line != null ? `${item.path}:${item.line}` : item.path) : null);
export const closeReason = (triage: BacklogTriage) => t('backlog.triage.closeReason', { verdict: triageTitle(triage), reason: triage.reason });

// PR, где запись всплывала, без повторов
export const prSources = (item: BacklogItem) => item.sources.filter((source, index) => item.sources.findIndex((other) => other.pr === source.pr) === index);

// Тот же порядок, что у `backlog export`: уровень, затем сколько раз проблема всплывала
export const byPriority = (a: BacklogItem, b: BacklogItem) => {
    const rank = (item: BacklogItem) => (LEVELS.includes(item.level) ? LEVELS.indexOf(item.level) : LEVELS.length);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.sources.length !== b.sources.length) return b.sources.length - a.sources.length;
    return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
};

// Репозитории — в порядке обзора; отключённые, у которых остались записи, — в конце. В «Все» открытые записи первыми
export const groups = (items: BacklogItem[], showAll: boolean, order: string[]) => {
    const shown = items.filter((item) => showAll || isOpen(item)).sort((a, b) => (isOpen(a) !== isOpen(b) ? (isOpen(a) ? -1 : 1) : byPriority(a, b)));
    const position = (repo: string) => (order.includes(repo) ? order.indexOf(repo) : order.length);
    const repos = [...new Set(shown.map((item) => item.repo))].sort((a, b) => position(a) - position(b) || a.localeCompare(b));
    return repos.map((repo) => ({ repo, items: shown.filter((item) => item.repo === repo) }));
};

// Строка указана для коммита последнего источника (у записей из истории — для коммита разбора по коду): на голове ветки она могла сдвинуться
export const fileUrl = (item: BacklogItem, config: Config) => {
    const repo = config.repos.find((entry) => entry.slug === item.repo);
    const commit = [...item.sources].reverse().find((source) => source.commit)?.commit ?? item.triage?.commit;
    if (!item.path || !repo || !commit) return null;
    const path = item.path.split('/').map(encodeURIComponent).join('/');
    return `https://bitbucket.org/${repo.workspace}/${repo.slug}/src/${commit}/${path}${item.line != null ? `#lines-${item.line}` : ''}`;
};

// Без хвоста про повторный запуск — правка пользователя в макете
export const lastScan = (scan: BacklogScan | null | undefined) => {
    const repos = Object.values(scan?.repos ?? {}).filter((repo) => parse(repo.at));
    if (!repos.length) return null;
    const at = new Date(Math.max(...repos.map((repo) => parse(repo.at)!.getTime())));
    const found = repos.reduce((sum, repo) => sum + (repo.found ?? 0), 0);
    const date = formatDate(at, { dateStyle: 'medium', timeStyle: 'short' });
    return found === 0 ? t('backlog.lastScan.none', { date }) : t('backlog.lastScan.found', { date, count: found });
};

export const triageHeading = (triage: BacklogTriage, now = new Date()) => {
    const title = triageTitle(triage);
    const commit = triage.commit ? ` · ${triage.branch ?? ''} ${triage.commit.slice(0, 7)}` : '';
    return t('backlog.triage.heading', { verdict: `${title[0].toUpperCase()}${title.slice(1)}`, ago: ago(triage.at, now), commit });
};
