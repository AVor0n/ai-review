import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent } from './agents.mjs';
import { addToBacklog, renderBacklogForPrompt } from './backlog.mjs';
import { authorOf, buildThreads, ownThreadsToCheck, pendingRoots, renderComments } from './comments.mjs';
import { anchorFinding, parseDiff } from './diff.mjs';
import { closingLine, confirmationLine, formatFinding, formatReply, splitConfirmations, withConfirmation, withMark } from './format.mjs';
import { INPUT_DIR_NAME, checkoutDetached, ensureClone, fetchOrigin, isAncestor, patchId, prDiff, rangeDiff, resolveCommit } from './git.mjs';
import { collectFeedback, learn, loadMemory } from './memory.mjs';
import { closeOutcomes, markResolved, recordClosed, trackOutcomes } from './outcomes.mjs';
import { buildPrompt } from './prompt.mjs';
import { refreshSnapshot } from './snapshot.mjs';
import { appendSkip, appendStats, log, logError, pushRecent } from './store.mjs';

const emptyCounts = () => ({ P0: 0, P1: 0, P2: 0, P3: 0 });

const post = async (ctx, repo, pr, body, failures) => {
    if (ctx.dryRun) {
        const where = body.parent ? `ответ на ${body.parent.id}` : `${body.inline.path}:${body.inline.to ?? body.inline.from}`;
        console.log(`\n──── [dry-run] ${repo.slug}#${pr.id} · ${where}\n${body.content.raw}`);
        return {};
    }
    try {
        return await ctx.bitbucket.postComment(repo, pr.id, body);
    } catch (error) {
        failures.push(error.message);
        logError(`ошибка публикации в ${repo.slug}#${pr.id}: ${error.message}`);
        return null;
    }
};

// Согласие без уточнения не заслуживает отдельного ответа: дописываем отметку в сам комментарий модели
const confirm = async (ctx, repo, pr, comment, agent, failures) => {
    const raw = comment.content?.raw ?? '';
    if (raw.includes(confirmationLine(agent))) return;
    const updated = withConfirmation(raw, agent);
    if (ctx.dryRun) {
        console.log(`\n──── [dry-run] ${repo.slug}#${pr.id} · отметка в ${comment.id}\n${confirmationLine(agent)}`);
        return;
    }
    try {
        await ctx.bitbucket.updateComment(repo, pr.id, comment.id, updated);
    } catch (error) {
        failures.push(error.message);
        logError(`не удалось отметить согласие в ${repo.slug}#${pr.id}, комментарий ${comment.id}: ${error.message}`);
    }
};

// Комментарий треда, с которым модель согласилась без своего текста. Чужой id или 0 — согласие с корнем;
// возражение встаёт только под ответом: корень оно как раз оспаривает
const agreedComment = (comments, reply) => {
    const thread = buildThreads(comments).find(({ root }) => root.id === reply.commentId);
    if (!thread) return null;
    if (reply.verdict !== 'agree') return thread.replies.find((comment) => comment.id === reply.agreesWith && !comment.deleted) ?? null;
    return [thread.root, ...thread.replies].find((comment) => comment.id === reply.agreesWith && !comment.deleted) ?? thread.root;
};

// Свой тред, который модель признала исправленным, неактуальным или отложенным: отметка в замечании, Resolve и исход в статистике.
// Отметка — до Resolve: если закрыть не удастся, причина всё равно видна в треде
const closeOwnThreads = async (ctx, { repo, pr, prState, agentId, commit, resolutions, own, comments }) => {
    const agent = ctx.config.agents[agentId];
    const byId = new Map(comments.map((comment) => [comment.id, comment]));
    const checked = new Map(own.map((item) => [item.root.id, item]));
    const failures = [];
    let closed = 0;
    let backlogged = 0;
    for (const resolution of resolutions) {
        const thread = checked.get(resolution.commentId);
        if (!thread || resolution.status === 'open') continue;
        if (['dismissed', 'deferred'].includes(resolution.status) && (!thread.lastHumanReply || !resolution.note?.trim())) continue;
        const root = byId.get(resolution.commentId);
        // В бэклог — до закрытия: закрытый тред больше не проверяется, и сбой Resolve не должен потерять проблему
        if (resolution.status === 'deferred') {
            backlogged += toBacklog(ctx, repo, pr, agentId, commit, backlogEntryFromComment(root, `Отложено в PR: ${resolution.note.trim()}`, ctx.config.agents), 'deferred');
        }
        const line = closingLine(agent, { status: resolution.status, commit, note: resolution.note ?? '' });
        if (ctx.dryRun) {
            console.log(`\n──── [dry-run] ${repo.slug}#${pr.id} · закрыть тред ${root.id}\n${line}`);
            continue;
        }
        try {
            await ctx.bitbucket.updateComment(repo, pr.id, root.id, withMark(root.content?.raw ?? '', line));
            await ctx.bitbucket.resolveComment(repo, pr.id, root.id);
            recordClosed(ctx, repo, pr.id, prState, root.id, resolution.status);
            closed++;
            log(`${repo.slug}#${pr.id} ${agentId}: тред ${root.id} закрыт — ${line}`);
        } catch (error) {
            failures.push(error.message);
            logError(`не удалось закрыть тред ${root.id} в ${repo.slug}#${pr.id}: ${error.message}`);
        }
    }
    return { closed, failures, backlogged };
};

// Возвращает 1, если проблема в бэклоге новая: повтор уже известной только добавляет источник
const toBacklog = (ctx, repo, pr, agentId, commit, entry, kind) => {
    if (ctx.dryRun) {
        console.log(`\n──── [dry-run] ${repo.slug}#${pr.id} · в бэклог\n[${entry.level}] ${entry.title}`);
        return 0;
    }
    const { item, added } = addToBacklog({ repo: repo.slug, ...entry }, { pr: pr.id, url: pr.links.html.href, agent: agentId, commit, kind });
    log(`${repo.slug}#${pr.id} ${agentId}: ${added ? 'в бэклог' : 'уже в бэклоге'} ${item.id} — ${entry.title}`);
    return added ? 1 : 0;
};

const backlogEntryFromFinding = (finding) => ({
    level: finding.level,
    likelihood: finding.likelihood ?? null,
    path: finding.path,
    line: finding.line,
    title: finding.title.trim().replace(/^\[P\d\]\s*/, ''),
    scenario: finding.scenario.trim(),
    fix: finding.fix.trim(),
});

// Замечание, уже опубликованное в PR, которое проверяющая модель признала старой проблемой или которое человек отложил:
// в треде его закроют, а сама проблема не должна потеряться
const backlogEntryFromComment = (comment, fix, agents) => {
    const markers = Object.values(agents).map((agent) => agent.marker);
    const body = splitConfirmations(comment.content?.raw ?? '').body
        .split('\n')
        .filter((line) => !markers.some((marker) => line.includes(marker)))
        .join('\n')
        .trim();
    const [first = '', ...rest] = body.split('\n');
    return {
        level: /^\[(P\d)\]/.exec(first)?.[1] ?? 'P3',
        likelihood: null,
        path: comment.inline?.path ?? null,
        line: comment.inline?.to ?? comment.inline?.from ?? null,
        title: first.replace(/^\[P\d\]\s*/, '').trim().slice(0, 200),
        scenario: rest.join('\n').trim(),
        fix,
    };
};

const publish = async (ctx, { repo, pr, agentId, role, pass, commit, result, files, pendingIds, comments }) => {
    const agent = ctx.config.agents[agentId];
    const byId = new Map(comments.map((comment) => [comment.id, comment]));
    const counts = emptyCounts();
    const verdicts = [];
    const failures = [];
    const synthetic = [];
    const tracked = [];
    const postedRoots = [];
    let dropped = 0;
    let backlogged = 0;
    let filtered = 0;

    for (const finding of result.findings) {
        if (finding.origin === 'preexisting') {
            backlogged += toBacklog(ctx, repo, pr, agentId, commit, backlogEntryFromFinding(finding), 'finding');
            continue;
        }
        // Редкий сценарий с лёгким последствием команда отклоняет, даже когда он верен
        if (finding.level === 'P3' && ['rare', 'race'].includes(finding.likelihood)) {
            filtered++;
            log(`${repo.slug}#${pr.id} ${agentId}: редкий P3 не опубликован — ${finding.title}`);
            continue;
        }
        const anchor = anchorFinding(files, finding);
        if (!anchor) {
            dropped++;
            log(`${repo.slug}#${pr.id} ${agentId}: строки ${finding.path}:${finding.line} нет в диффе, замечание пропущено — ${finding.title}`);
            continue;
        }
        if (anchor.moved) log(`${repo.slug}#${pr.id} ${agentId}: ${finding.path}:${finding.line} привязано к ближайшей строке диффа`);
        const raw = formatFinding(finding, agent);
        const posted = await post(ctx, repo, pr, { content: { raw }, inline: anchor.inline }, failures);
        if (posted) {
            counts[finding.level]++;
            if (posted.id) postedRoots.push(posted.id);
            synthetic.push({ id: -1 - synthetic.length, content: { raw }, inline: anchor.inline });
            // Замечание к удалённой строке отслеживается по месту удаления в новой версии файла
            if (anchor.track?.line) {
                tracked.push({
                    commentId: posted.id ?? null,
                    agent: agentId,
                    role,
                    pass,
                    author: pr.author?.display_name ?? null,
                    level: finding.level,
                    title: finding.title.trim(),
                    ...(finding.lessons?.length ? { lessons: finding.lessons } : {}),
                    path: anchor.track.path,
                    line: anchor.track.line,
                    commit,
                    at: new Date().toISOString(),
                });
            }
        }
    }

    const unanswered = new Set(pendingIds);
    for (const reply of result.replies) {
        if (!unanswered.delete(reply.commentId)) continue;
        const root = byId.get(reply.commentId);
        verdicts.push({ target: authorOf(root, ctx.config.agents), verdict: reply.verdict, reason: reply.reason ?? null });
        if (reply.verdict === 'skip') continue;
        if (reply.verdict === 'disagree' && reply.reason === 'preexisting' && root) {
            backlogged += toBacklog(ctx, repo, pr, agentId, commit, backlogEntryFromComment(root, reply.comment?.trim() ? `Почему вне PR: ${reply.comment.trim()}` : '', ctx.config.agents), 'reply');
        }
        // Голое «согласен» отдельным ответом — шум: отметка встаёт под тем комментарием модели, с которым она согласна;
        // под комментарием человека и под своим — ничего
        if (!reply.comment?.trim()) {
            const agreed = agreedComment(comments, reply);
            const author = agreed && authorOf(agreed, ctx.config.agents);
            if (author && author !== 'human' && author !== agentId) await confirm(ctx, repo, pr, agreed, agent, failures);
            continue;
        }
        const raw = formatReply(reply, agent);
        if (await post(ctx, repo, pr, { content: { raw }, parent: { id: reply.commentId } }, failures)) {
            synthetic.push({ id: -1 - synthetic.length, parent: { id: reply.commentId }, content: { raw } });
        }
    }
    // Без этого тред, который модель проигнорировала, перезапускал бы её каждые 15 минут
    if (unanswered.size) log(`${repo.slug}#${pr.id} ${agentId}: нет ответа на треды ${[...unanswered].join(', ')}, помечены обработанными`);

    return { counts, verdicts, failures, dropped, backlogged, filtered, synthetic, tracked, postedRoots, handledIds: pendingIds };
};

const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// Ответ в тредах — проверка одного-двух утверждений, а не ревью всего PR: высокий reasoning там почти ничего не даёт.
// Уровень только понижается; у Cursor он зашит в имя модели и не меняется
const runConfigFor = (agent, review) => {
    if (review) return agent;
    const target = agent.repliesEffort ?? 'medium';
    const lower = (current) => (EFFORT_ORDER.indexOf(target) >= 0 && EFFORT_ORDER.indexOf(target) < EFFORT_ORDER.indexOf(current) ? target : current);
    return {
        ...agent,
        ...(agent.effort ? { effort: lower(agent.effort) } : {}),
        ...(agent.reasoningEffort ? { reasoningEffort: lower(agent.reasoningEffort) } : {}),
    };
};

const writeInputs = (inputDir, files) => {
    rmSync(inputDir, { recursive: true, force: true });
    mkdirSync(inputDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(inputDir, name), content);
};

// fetch — секунды сети на каждый репозиторий, поэтому только когда в клоне нет головы или базы какого-то PR:
// Bitbucket отдаёт оба хэша в списке PR, и если они уже на месте, качать нечего
const getClone = (ctx, repo, prs = null) => {
    ctx.clones ??= new Map();
    if (!ctx.clones.has(repo.slug)) {
        const clone = ensureClone(repo);
        const missing = !prs || prs.some((pr) => !resolveCommit(clone, pr.source.commit.hash) || !resolveCommit(clone, pr.destination.commit.hash));
        if (missing) fetchOrigin(clone);
        ctx.clones.set(repo.slug, clone);
    }
    return ctx.clones.get(repo.slug);
};

// Ответ, оставленный прямо перед слиянием, иначе не попал бы в память: у закрытого PR комментарии больше не читаются.
// Обмены лежат в состоянии, пока память их не разберёт, — переживают и паузу репозитория, и сбой модели
const keepClosedFeedback = (ctx, repo, repoState, id, comments) => {
    const pr = { id, links: { html: { href: `https://bitbucket.org/${repo.workspace}/${repo.slug}/pull-requests/${id}` } } };
    const exchanges = collectFeedback(pr, comments, ctx.config.agents, new Set(repoState.learned ?? []));
    if (exchanges.length) repoState.closedFeedback = [...(repoState.closedFeedback ?? []), ...exchanges].slice(-100);
};

// Итоговые комментарии закрытого PR нужны дважды: для исходов замечаний (закрыт ли тред) и для памяти
const readClosedComments = async (ctx, repo, id) => {
    if (ctx.dryRun) return null;
    try {
        return await ctx.bitbucket.listComments(repo, id);
    } catch (error) {
        logError(`${repo.slug}#${id}: не удалось прочитать комментарии закрытого PR — ${error.message}`);
        return null;
    }
};

const syncRepo = async (ctx, repo) => {
    const open = await ctx.bitbucket.listOpenPrs(repo);
    // Свежий fetch нужен и для ревью, и для подсчёта отставания веток в обзоре
    const comments = ctx.dryRun ? {} : await refreshSnapshot(ctx.bitbucket, repo, open, repo.paused ? null : getClone(ctx, repo, open));
    const repoState = (ctx.state.repos[repo.slug] ??= { prs: {} });
    for (const pr of open) {
        const prState = repoState.prs[pr.id];
        if (!prState) continue;
        if (comments[pr.id]) markResolved(prState, comments[pr.id], ctx.config.agents);
        // Замечания, записанные до появления поля автора, получают его здесь — пока PR открыт, автор известен
        for (const finding of prState.findings ?? []) finding.author ??= pr.author?.display_name ?? null;
    }
    for (const id of Object.keys(repoState.prs)) {
        if (open.some((pr) => String(pr.id) === id)) continue;
        const closedComments = await readClosedComments(ctx, repo, Number(id));
        await closeOutcomes(ctx, repo, Number(id), repoState.prs[id], () => getClone(ctx, repo), closedComments);
        if (closedComments) keepClosedFeedback(ctx, repo, repoState, Number(id), closedComments);
        delete repoState.prs[id];
        ctx.save();
    }
    return { open, repoState, comments };
};

const updateMemory = async (ctx, repo, repoState, open, comments) => {
    const seen = new Set(repoState.learned ?? []);
    const closed = (repoState.closedFeedback ?? []).filter((exchange) => exchange.newIds.some((id) => !seen.has(id)));
    const exchanges = [...closed, ...open.flatMap((pr) => (comments[pr.id] ? collectFeedback(pr, comments[pr.id], ctx.config.agents, seen) : []))];
    const processed = await learn(ctx, repo, exchanges);
    if (!processed.length) return;
    // Хватает с запасом на все открытые PR; ids закрытых PR больше не встретятся
    repoState.learned = [...seen, ...processed.flatMap((exchange) => exchange.newIds)].slice(-5000);
    const learned = new Set(repoState.learned);
    repoState.closedFeedback = closed.filter((exchange) => exchange.newIds.some((id) => !learned.has(id)));
    ctx.save();
};

// forced — id модели из явной заявки: она ревьюит голову заново, даже если уже ревьюила её, и даже черновик
const reviewPr = async (ctx, repo, repoState, pr, forced = null) => {
    const { bitbucket, config, state } = ctx;
    const agents = config.agents;
    const agentIds = Object.keys(agents);
    // Выключенная в настройках модель в фоне не ревьюит и не отвечает в тредах; явный запуск из окна работает всегда
    const autoIds = agentIds.filter((id) => agents[id].auto !== false);

    const prState = (repoState.prs[pr.id] ??= { reviewed: {}, handled: {}, commentCount: null });
    for (const id of agentIds) prState.handled[id] ??= [];
    const head = pr.source.commit.hash.slice(0, 12);
    let needsReview = forced ? [forced] : autoIds.filter((id) => prState.reviewed[id] !== head);
    if (!forced && !needsReview.length && prState.commentCount === pr.comment_count) return;

    let comments = await bitbucket.listComments(repo, pr.id);
    const pendingFor = (id) => pendingRoots(comments, id, prState.handled[id], agents).map((comment) => comment.id);
    prState.ownChecks ??= {};
    const ownFor = (id) => ownThreadsToCheck(comments, id, agents, head, prState.ownChecks[id]);
    if (!forced && !needsReview.length && autoIds.every((id) => !pendingFor(id).length && !ownFor(id).length)) {
        prState.commentCount = pr.comment_count;
        ctx.save();
        return;
    }

    const clone = getClone(ctx, repo);
    const commit = resolveCommit(clone, pr.source.commit.hash);
    if (!commit) {
        log(`${repo.slug}#${pr.id}: коммит ${head} ещё не пришёл с fetch, пропускаю до следующего запуска`);
        return;
    }
    trackOutcomes(ctx, repo, pr.id, prState, clone, commit);
    ctx.save();
    checkoutDetached(clone, commit);
    const inputDir = join(clone, INPUT_DIR_NAME);
    const exclude = config.ignorePaths ?? [];
    const diff = prDiff(clone, pr.destination.branch.name, commit, exclude);
    // Объём вырезанного — для оценки экономии в статистике; полный дифф нужен только ради этой разницы
    const excludedBytes = exclude.length ? Math.max(0, prDiff(clone, pr.destination.branch.name, commit).length - diff.length) : 0;
    const files = parseDiff(diff);
    // Объём изменений PR — знаменатель для «замечаний на 1000 строк»: без него больше всех «ошибается» тот, кто больше пишет
    const diffLines = diff.split('\n').filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line)).length;

    // После rebase или подтягивания целевой ветки голова новая, а изменения PR те же — повторный раунд был бы пустой тратой.
    // Пустой дифф пропускается и на первом ревью: модель всё равно читает промпт и репозиторий, а находить ей нечего
    const patch = patchId(clone, diff);
    prState.patch ??= {};
    if (!forced) {
        const unchanged = needsReview.filter((id) => patch === null || (prState.reviewed[id] && prState.patch[id] === patch));
        for (const id of unchanged) {
            prState.reviewed[id] = head;
            prState.patch[id] = patch;
        }
        if (unchanged.length) {
            const reason = patch !== null ? 'rebase' : excludedBytes ? 'ignored' : 'empty';
            const reasonText = {
                rebase: 'изменения те же, что на прошлом ревью (rebase или слияние целевой ветки)',
                ignored: 'в диффе только исключённые файлы',
                empty: 'в PR нет изменений относительно целевой ветки',
            }[reason];
            log(`${repo.slug}#${pr.id}: ${unchanged.join(', ')} — ревью головы ${head} пропущено, ${reasonText}`);
            if (!ctx.dryRun) {
                for (const agent of unchanged) {
                    appendSkip({ at: new Date().toISOString(), repo: repo.slug, pr: pr.id, author: pr.author?.display_name ?? null, agent, reason });
                }
            }
            needsReview = needsReview.filter((id) => !unchanged.includes(id));
            ctx.save();
        }
    }

    const fullRound = !forced && autoIds.length > 1 && needsReview.length === autoIds.length;
    const order = forced ? [forced] : autoIds.includes(state.nextFirst) ? [state.nextFirst, ...autoIds.filter((id) => id !== state.nextFirst)] : autoIds;

    for (const agentId of order) {
        const review = needsReview.includes(agentId);
        const pendingIds = pendingFor(agentId);
        const own = ownFor(agentId);
        if (!review && !pendingIds.length && !own.length) continue;

        const othersReviewedHead = agentIds.some((id) => id !== agentId && prState.reviewed[id] === head);
        const role = !review ? 'replies' : othersReviewedHead ? 'second' : 'first';
        const previousCommit = prState.reviewed[agentId];
        // Тип ревью для статистики: первое ревью PR, повторное после новых коммитов или только ответы в тредах
        const pass = !review ? 'replies' : previousCommit ? 'followup' : 'initial';
        const previousFull = review && previousCommit ? resolveCommit(clone, previousCommit) : null;
        // При повторном ревью той же головы инкрементальный дифф пустой — он только сбил бы модель
        const hasIncremental = Boolean(previousFull && previousFull !== commit && isAncestor(clone, previousFull, commit));

        const description = pr.description?.trim() ?? '';
        const backlog = review ? renderBacklogForPrompt(repo.slug) : '';
        writeInputs(inputDir, {
            'diff.patch': diff,
            ...(description ? { 'description.md': description } : {}),
            'comments.md': renderComments(comments, agents, pendingIds),
            ...(backlog ? { 'backlog.md': `${backlog}\n` } : {}),
            ...(hasIncremental ? { 'incremental.patch': rangeDiff(clone, previousFull, commit, exclude) } : {}),
        });

        const otherAgents = agentIds.filter((id) => id !== agentId).map((id) => agents[id]);
        const lessons = loadMemory(repo.slug);
        const lessonIds = new Set(lessons.map((lesson) => lesson.id));
        const prompt = buildPrompt({ repo, pr, agent: agents[agentId], otherAgents, review, pendingIds, ownIds: own.map((item) => item.root.id), hasDescription: Boolean(description), hasIncremental, previousCommit, lessons, excluded: exclude, hasBacklog: Boolean(backlog) });
        const runConfig = runConfigFor(agents[agentId], review);
        const startedAt = Date.now();
        ctx.setCurrent({ repo: repo.slug, pr: pr.id, title: pr.title, agent: agentId, role, startedAt: new Date(startedAt).toISOString() });
        log(`${repo.slug}#${pr.id} ${agentId}: старт (${role}${forced ? ', явный запуск' : ''}, ответов: ${pendingIds.length})`);

        let result;
        let usage;
        try {
            ({ data: result, usage } = await runAgent(agentId, runConfig, { cwd: clone, prompt, workDir: ctx.workDir }));
        } catch (error) {
            ctx.errors.push(`${repo.slug}#${pr.id} ${agentId}: ${error.message}`);
            logError(`${repo.slug}#${pr.id} ${agentId}: ошибка — ${error.message}`);
            continue;
        }

        const outcome = await publish(ctx, { repo, pr, agentId, role, pass, commit, result, files, pendingIds, comments });
        const closing = await closeOwnThreads(ctx, { repo, pr, prState, agentId, commit, resolutions: result.resolutions, own, comments });
        outcome.failures.push(...closing.failures);
        outcome.backlogged += closing.backlogged;
        // Проверенные треды не перепроверяются, пока не придёт новый коммит или новый ответ человека.
        // Только что опубликованные замечания тоже проверены на этой голове: иначе следующий проход перепроверял бы их впустую
        prState.ownChecks[agentId] = {
            ...prState.ownChecks[agentId],
            ...Object.fromEntries(own.map((item) => [item.root.id, { head, lastHumanReply: item.lastHumanReply }])),
            ...Object.fromEntries(outcome.postedRoots.map((id) => [id, { head, lastHumanReply: 0 }])),
        };
        if (review) {
            prState.reviewed[agentId] = head;
            prState.patch[agentId] = patch;
        }
        (prState.findings ??= []).push(...outcome.tracked);
        prState.handled[agentId].push(...outcome.handledIds);
        prState.commentCount = null;
        ctx.errors.push(...outcome.failures.map((message) => `${repo.slug}#${pr.id}: ${message}`));

        const entry = {
            at: new Date().toISOString(),
            repo: repo.slug,
            pr: pr.id,
            title: pr.title,
            url: pr.links.html.href,
            head,
            agent: agentId,
            model: agents[agentId].model ?? null,
            effort: runConfig.effort ?? runConfig.reasoningEffort ?? null,
            role,
            pass,
            author: pr.author?.display_name ?? null,
            manual: Boolean(forced),
            excludedBytes: review ? excludedBytes : 0,
            diffLines,
            findings: outcome.counts,
            dropped: outcome.dropped,
            backlogged: outcome.backlogged,
            filtered: outcome.filtered,
            verdicts: outcome.verdicts,
            closedThreads: closing.closed,
            // Только известные id: модель может ошибиться в id, а статистика правил по ним считает срабатывания
            appliedLessons: (result.appliedLessons ?? []).filter((id) => lessonIds.has(id)),
            durationSec: Math.round((Date.now() - startedAt) / 1000),
            usage,
        };
        log(`${repo.slug}#${pr.id} ${agentId}: готово — ${JSON.stringify(entry.findings)}, ответов ${entry.verdicts.length}`);
        if (!ctx.dryRun) {
            appendStats(entry);
            pushRecent(entry);
        }
        ctx.save();
        comments = ctx.dryRun ? [...comments, ...outcome.synthetic] : await bitbucket.listComments(repo, pr.id);
    }

    if (fullRound && autoIds.every((id) => prState.reviewed[id] === head)) {
        // Первым по очереди ходит каждая модель: при трёх и больше «следующая за текущей», а не просто вторая в списке
        state.nextFirst = autoIds[(autoIds.indexOf(order[0]) + 1) % autoIds.length];
        ctx.save();
    }
    rmSync(inputDir, { recursive: true, force: true });
};

// Фоном ревьюим только ветки задач: PR вроде develop → master — это перенос уже проверенного кода
const DEFAULT_BRANCH_PATTERN = 'PROJ-\\d+';
const isTaskBranch = (config, pr) => new RegExp(config.branchPattern ?? DEFAULT_BRANCH_PATTERN, 'i').test(pr.source.branch.name);

export const reviewRepo = async (ctx, repo) => {
    const { open, repoState, comments } = await syncRepo(ctx, repo);
    if (repo.paused) return;
    // Память обновляем до ревью, чтобы свежие ответы команды учлись уже в этом проходе
    await updateMemory(ctx, repo, repoState, open, comments);
    for (const pr of open.filter((pr) => !pr.draft && (!ctx.onlyPr || pr.id === ctx.onlyPr) && isTaskBranch(ctx.config, pr))) {
        await reviewPr(ctx, repo, repoState, pr);
    }
};

export const reviewRequested = async (ctx, repo, requests) => {
    const { open, repoState, comments } = await syncRepo(ctx, repo);
    await updateMemory(ctx, repo, repoState, open, comments);
    for (const request of requests) {
        const pr = open.find((candidate) => candidate.id === request.pr);
        if (!pr) {
            log(`${repo.slug}#${request.pr}: PR уже не открыт, заявка на ревью ${request.agent} снята`);
            continue;
        }
        await reviewPr(ctx, repo, repoState, pr, request.agent);
    }
};
