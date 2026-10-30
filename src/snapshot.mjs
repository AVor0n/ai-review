import { authorOf } from './comments.mjs';
import { branchStatus } from './git.mjs';
import { loadConfig, savePrSnapshot } from './store.mjs';

const PARALLEL = 4;

// Закрытие треда не меняет comment_count PR, поэтому комментарии перечитываются у каждого PR с комментариями
const countThreads = (comments, agents, me) => {
    const roots = comments.filter((comment) => !comment.parent && !comment.deleted && !comment.pending);
    const resolved = roots.filter((comment) => comment.resolution).length;
    // Открытые треды кратко — окно сравнивает их с тем, что видела последняя доработка
    const openRoots = roots
        .filter((comment) => !comment.resolution)
        .map((comment) => {
            const agent = authorOf(comment, agents);
            return {
                id: comment.id,
                author: agent === 'human' ? (comment.user?.display_name ?? null) : agents[agent].shortName,
                text: firstLine(comment),
                path: comment.inline?.path ?? null,
                url: comment.links?.html?.href ?? null,
                at: comment.created_on ?? null,
            };
        });
    return { open: roots.length - resolved, resolved, openRoots, humans: humanComments(comments, agents, me) };
};

// Упоминания в сыром тексте — @{id аккаунта}: имени там нет, в уведомлении это мусор
const firstLine = (comment) =>
    (comment.content?.raw ?? '').replace(/@\{[^}]+\}\s*/g, '').split('\n').find((line) => line.trim())?.trim().slice(0, 160) ?? '';

// Последние комментарии людей, кроме своих, — для уведомлений окна о новых тредах и ответах
const RECENT_HUMAN = 30;
const humanComments = (comments, agents, me) =>
    comments
        .filter((comment) => !comment.deleted && !comment.pending && authorOf(comment, agents) === 'human' && comment.user?.account_id !== me)
        .sort((a, b) => a.id - b.id)
        .slice(-RECENT_HUMAN)
        .map((comment) => ({
            id: comment.id,
            author: comment.user?.display_name ?? null,
            text: firstLine(comment),
            reply: Boolean(comment.parent),
            path: comment.inline?.path ?? null,
            url: comment.links?.html?.href ?? null,
            at: comment.created_on ?? null,
        }));

// Возвращает прочитанные комментарии по id PR: их же разбирает память ревьюеров.
// clone — служебный клон: по нему считается, насколько ветка отстала от базы (без клона поля просто не заполняются)
export const refreshSnapshot = async (bitbucket, repo, prs, clone = null, agents = loadConfig().agents) => {
    const threads = {};
    const comments = {};
    const me = (await bitbucket.currentUser().catch(() => null))?.account_id ?? null;
    const queue = prs.filter((pr) => pr.comment_count > 0);
    const worker = async () => {
        for (let pr = queue.shift(); pr; pr = queue.shift()) {
            comments[pr.id] = await bitbucket.listComments(repo, pr.id);
            threads[pr.id] = countThreads(comments[pr.id], agents, me);
        }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    // Считаем по хэшам из Bitbucket — так же, как видит PR он сам; если коммитов ещё нет в клоне, по веткам из последнего fetch
    const branches = clone
        ? Object.fromEntries(prs.map((pr) => [pr.id, branchStatus(clone, pr.source.commit.hash, pr.destination.commit.hash) ?? branchStatus(clone, `origin/${pr.source.branch.name}`, `origin/${pr.destination.branch.name}`)]))
        : {};
    savePrSnapshot(repo.slug, prs, threads, branches);
    return comments;
};
