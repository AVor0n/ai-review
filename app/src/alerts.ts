import { minutesText } from './model/format';
import { findingUrl, workerStall } from './model/derive';
import { allows, allowsLevel, levelsText, rulesFor, type NotificationKind, type NotificationSettings } from './model/notifications';
import type { Data, FixState, PullRequest } from './model/types';

// Какие системные уведомления показать — перенос Notifier.check из menubar/Alerts.swift. Чистая функция: на входе данные
// и то, о чём уже сообщили, на выходе уведомления и новые отметки. Проверка идёт и при выключенных уведомлениях —
// чтобы двигать отметки: после включения не придёт пачка пропущенного
export type Notice = { id: string; kind: NotificationKind; title: string; subtitle?: string; body: string; url?: string | null };

// since-отметки по видам — время последнего события, о котором уже сообщили; heads и lastRunAt — с прошлой проверки
export type AlertMemory = {
    since: Record<'findings' | 'comments' | 'fixes', string>;
    heads: Record<string, Record<number, string>>;
    lastRunAt: string | null | undefined;
    stall: string | null;
};

export type HumanComment = { id: number; author?: string | null; text: string; reply: boolean; url?: string | null; at?: string | null };
type Pr = PullRequest & { humanComments?: HumanComment[] | null };
type Fix = FixState & { finishedAt?: string | null; report?: (FixState['report'] & { head?: string | null }) | null };

const KEY = 'pr-reviewer.notifiedSince';

// Первый запуск — отсчёт с текущего момента: старые замечания и комментарии не всплывут разом
export const initialMemory = (now = new Date()): AlertMemory => {
    let since: Partial<AlertMemory['since']> = {};
    try {
        since = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    } catch {
        // Повреждённые отметки — как первый запуск
    }
    const start = now.toISOString();
    return { since: { findings: since.findings ?? start, comments: since.comments ?? start, fixes: since.fixes ?? start }, heads: {}, lastRunAt: undefined, stall: null };
};

export const saveMemory = (memory: AlertMemory) => {
    try {
        localStorage.setItem(KEY, JSON.stringify(memory.since));
    } catch {
        // Без хранилища отметки живут до перезапуска
    }
};

const groupBy = <T>(items: T[], key: (item: T) => string) =>
    items.reduce<Record<string, T[]>>((groups, item) => {
        (groups[key(item)] ??= []).push(item);
        return groups;
    }, {});

// Одно и то же время у нескольких событий: граница включается в отметку, поэтому сравнение строгое
const fresh = <T>(items: T[], since: string, at: (item: T) => string | null | undefined) => {
    const result = items.filter((item) => (at(item) ?? '') > since);
    const latest = result.reduce((max, item) => ((at(item) ?? '') > max ? (at(item) as string) : max), since);
    return { items: result, since: latest };
};

export const checkAlerts = (data: Data, settings: NotificationSettings, memory: AlertMemory, agentName: (id: string) => string, now = new Date()) => {
    const notices: Notice[] = [];
    const next: AlertMemory = { ...memory, since: { ...memory.since }, heads: { ...memory.heads } };
    const prs = Object.entries(data.snapshots).flatMap(([repo, snapshot]) => (snapshot?.prs ?? []).map((pr) => ({ repo, pr: pr as Pr })));

    // Замечания моделей: одно уведомление на запуск модели по PR, а не на каждое замечание
    const open = prs.flatMap(({ repo, pr }) => (data.state.repos?.[repo]?.prs[String(pr.id)]?.findings ?? []).filter((finding) => finding.resolved !== true).map((finding) => ({ repo, pr, finding })));
    const findings = fresh(open, memory.since.findings, (item) => item.finding.at);
    next.since.findings = findings.since;
    const allowed = findings.items.filter((item) => allows(settings, 'findings', item.repo) && allowsLevel(rulesFor(settings, item.repo), item.finding.level));
    for (const group of Object.values(groupBy(allowed, (item) => `${item.repo}#${item.pr.id}#${item.finding.agent}`))) {
        const first = group[0];
        const counts = group.reduce<Record<string, number>>((all, item) => ({ ...all, [item.finding.level]: (all[item.finding.level] ?? 0) + 1 }), {});
        notices.push({
            id: `${first.repo}#${first.pr.id}#${first.finding.agent}#${first.finding.at}`,
            kind: 'findings',
            title: `${levelsText(counts)} в ${first.repo} #${first.pr.id} · ${agentName(first.finding.agent)}`,
            subtitle: first.pr.title,
            body: group.map((item) => `${item.finding.level}: ${item.finding.title}`).join('\n'),
            url: findingUrl(first.pr, first.finding),
        });
    }

    // Комментарии людей, кроме ваших: сервис отдаёт их в снимке PR
    const all = prs.flatMap(({ repo, pr }) => (pr.humanComments ?? []).map((comment) => ({ repo, pr, comment })));
    const comments = fresh(all, memory.since.comments, (item) => item.comment.at);
    next.since.comments = comments.since;
    for (const group of Object.values(groupBy(comments.items.filter((item) => allows(settings, 'comments', item.repo)), (item) => `${item.repo}#${item.pr.id}`))) {
        const first = group[0];
        const last = group[group.length - 1];
        const authors = [...new Set(group.map((item) => item.comment.author).filter(Boolean))].sort().join(', ');
        notices.push({
            id: `comments#${first.repo}#${first.pr.id}#${last.comment.id}`,
            kind: 'comments',
            title: group.length > 1 ? `${group.length} комментария в ${first.repo} #${first.pr.id}` : `${first.comment.reply ? 'Ответ' : 'Комментарий'} в ${first.repo} #${first.pr.id}`,
            subtitle: authors || first.pr.title,
            body: group.map((item) => `${item.comment.author ? `${item.comment.author}: ` : ''}${item.comment.text}`).join('\n'),
            url: last.comment.url ?? first.pr.url,
        });
    }

    // Обновление PR: новые коммиты, новые и закрытые PR. Репозиторий впервые в поле зрения — только точка отсчёта
    const fixes = data.fixes as Fix[];
    for (const [repo, snapshot] of Object.entries(data.snapshots)) {
        if (!snapshot) continue;
        const current = Object.fromEntries(snapshot.prs.map((pr) => [pr.id, pr]));
        const known = memory.heads[repo];
        next.heads[repo] = Object.fromEntries(snapshot.prs.map((pr) => [pr.id, pr.head]));
        if (!known || !allows(settings, 'updates', repo)) continue;
        for (const pr of snapshot.prs) {
            if (!(pr.id in known)) {
                notices.push({ id: `new#${repo}#${pr.id}`, kind: 'updates', title: `Новый PR ${repo} #${pr.id}`, subtitle: pr.author ?? '', body: pr.title, url: pr.url });
                continue;
            }
            // Свой пуш доработки — уже сообщила доработка
            const pushedByFix = fixes.some((fix) => fix.repo === repo && fix.pr === pr.id && fix.report?.head === pr.head);
            if (known[pr.id] !== pr.head && !pushedByFix) notices.push({ id: `push#${repo}#${pr.id}#${pr.head}`, kind: 'updates', title: `Новые коммиты в ${repo} #${pr.id}`, subtitle: pr.author ?? '', body: pr.title, url: pr.url });
        }
        for (const [id, head] of Object.entries(known)) {
            if (!current[Number(id)]) notices.push({ id: `closed#${repo}#${id}#${head}`, kind: 'updates', title: `PR ${repo} #${id} закрыт`, body: 'Влит или отклонён' });
        }
    }

    // Итог доработки и rebase
    const finished = fresh(
        fixes.filter((fix) => fix.state !== 'queued' && fix.state !== 'running'),
        memory.since.fixes,
        (fix) => fix.finishedAt,
    );
    next.since.fixes = finished.since;
    for (const fix of finished.items.filter((item) => allows(settings, 'fixes', item.repo))) {
        const rebase = fix.mode === 'rebase';
        const counts = rebase || !fix.report ? '' : `\nИсправлено ${fix.report.fixed?.length ?? 0}, не исправлено ${fix.report.skipped?.length ?? 0}`;
        const pr = prs.find((item) => item.repo === fix.repo && item.pr.id === fix.pr)?.pr;
        notices.push({
            id: `fix#${fix.repo}#${fix.pr}#${fix.finishedAt ?? ''}`,
            kind: 'fixes',
            title: `${rebase ? 'Rebase' : 'Доработка'} ${fix.repo} #${fix.pr}${fix.state === 'done' ? '' : ' не удалась'}`,
            subtitle: pr?.title ?? '',
            body: `${fix.report?.message ?? fix.error ?? ''}${counts}`,
            url: pr?.url ?? null,
        });
    }

    // Ошибки сервиса: первая ошибка подряд — по новому проходу; зависший проход — один раз на проход
    const status = data.status;
    if (status) {
        const previous = memory.lastRunAt;
        next.lastRunAt = status.lastRunAt ?? null;
        if (previous !== undefined && previous !== next.lastRunAt && status.phase === 'error' && status.errorStreak === 1 && status.lastError && allows(settings, 'errors')) {
            notices.push({ id: `error#${status.lastRunAt ?? ''}`, kind: 'errors', title: 'PR Reviewer: проход завершился с ошибкой', body: status.lastError });
        }
    }
    const stall = workerStall(status, now);
    const run = status?.lastRunAt ?? 'run';
    if (stall && run !== memory.stall && allows(settings, 'errors')) {
        next.stall = run;
        notices.push({ id: `stall#${run}`, kind: 'errors', title: 'Проход ревью завис', body: `Сервис не отвечает ${minutesText(stall.minutes)} — похоже, завис git или сеть. Прервать проход можно в «Обзоре».` });
    }

    return { notices, memory: next };
};
