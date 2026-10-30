import { spawnSync } from 'node:child_process';
import { authorOf, buildThreads } from './comments.mjs';
import { pushedFixes } from './fix.mjs';
import { isAncestor, resolveCommit } from './git.mjs';
import { appendOutcome, logError } from './store.mjs';

// Насколько далеко от строки замечания может быть правка, чтобы считать её реакцией на замечание
const NEARBY_LINES = 2;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm;

// Диапазоны строк версии `from`, которые правка затронула; чистая вставка — точка между строками
const changedRanges = (clone, from, to, path) => {
    const result = spawnSync('git', ['diff', '-U0', '--no-color', '--no-ext-diff', from, to, '--', path], {
        cwd: clone,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) return [];
    return [...result.stdout.matchAll(HUNK)].map(([, start, count = '1']) => {
        const first = Number(start);
        return Number(count) === 0 ? [first, first + 1] : [first, first + Number(count) - 1];
    });
};

// Правка рядом со строкой замечания — или отчёт доработки, что она исправила это замечание: модель могла
// чинить причину в другом месте файла, далеко от строки, к которой привязан комментарий
const isAddressed = (clone, finding, commit, fixes) =>
    fixes.some((fix) => fix.fixedIds.includes(finding.commentId) && isAncestor(clone, fix.head, commit)) ||
    changedRanges(clone, finding.commit, commit, finding.path).some(
        ([first, last]) => first - NEARBY_LINES <= finding.line && finding.line <= last + NEARBY_LINES,
    );

const record = (ctx, repo, prId, finding, outcome) => {
    if (ctx.dryRun) return;
    appendOutcome({
        at: new Date().toISOString(),
        repo: repo.slug,
        pr: prId,
        agent: finding.agent,
        role: finding.role,
        pass: finding.pass ?? null,
        author: finding.author ?? null,
        path: finding.path,
        level: finding.level,
        commentId: finding.commentId,
        outcome,
        ...(finding.lessons?.length ? { lessons: finding.lessons } : {}),
        // Человек ответил в треде, а код не правили — замечание оспорили, а не молча пропустили
        ...(outcome === 'addressed' ? {} : { disputed: Boolean(finding.disputed) }),
        hours: Math.round((Date.now() - Date.parse(finding.at)) / 36e5),
    });
};

// Модель сама закрыла свой тред: исправлено — или команда в треде объяснила, что править не нужно (это спор, а не молчание)
export const recordClosed = (ctx, repo, prId, prState, commentId, status) => {
    const finding = prState.findings?.find((item) => item.commentId === commentId);
    if (!finding) return;
    // Отложенное замечание верно, просто не сейчас: в статистике это не отклонение и не спор
    const outcome = { fixed: 'addressed', deferred: 'deferred' }[status] ?? 'dismissed';
    record(ctx, repo, prId, { ...finding, disputed: status !== 'fixed' }, outcome);
    prState.findings = prState.findings.filter((item) => item !== finding);
};

// Новая голова PR: замечания, рядом с которыми правили код, считаем исправленными
export const trackOutcomes = (ctx, repo, prId, prState, clone, commit) => {
    if (!prState.findings?.length) return;
    const fixes = pushedFixes(repo.slug, prId);
    prState.findings = prState.findings.filter((finding) => {
        if (finding.commit === commit || !resolveCommit(clone, finding.commit)) return true;
        if (!isAddressed(clone, finding, commit, fixes)) return true;
        record(ctx, repo, prId, finding, 'addressed');
        return false;
    });
};

// PR закрыт: у влитого досчитываем по финальному коммиту, у отклонённого замечания в метрику не идут
// Закрытый через Resolve тред, рядом с которым код не правили, — вероятно, ложное или ненужное замечание.
// Ответ человека в треде запоминается сразу: к закрытию PR комментарии могут быть недоступны
export const markResolved = (prState, comments, agents) => {
    const resolved = new Set(comments.filter((comment) => comment.resolution).map((comment) => comment.id));
    const answered = new Set(
        buildThreads(comments)
            .filter(({ replies }) => replies.some((reply) => !reply.deleted && authorOf(reply, agents) === 'human'))
            .map(({ root }) => root.id),
    );
    for (const finding of prState.findings ?? []) {
        finding.resolved = resolved.has(finding.commentId);
        finding.disputed = answered.has(finding.commentId);
    }
};

// comments — итоговые комментарии PR или null, если их не удалось прочитать: тогда берём последнее известное состояние тредов
export const closeOutcomes = async (ctx, repo, prId, prState, getClone, comments) => {
    if (!prState.findings?.length) return;
    let outcome = 'unknown';
    let finalCommit = null;
    let clone = null;
    try {
        const pr = await ctx.bitbucket.getPrOutcome(repo, prId);
        if (pr.state !== 'MERGED') outcome = 'declined';
        else {
            clone = getClone();
            finalCommit = resolveCommit(clone, pr.source.commit.hash);
            // Ветку после слияния могли удалить, а squash не оставляет коммит в истории — тогда исход неизвестен
            // Влить PR, не исправив замечание, — тоже решение «править не будем», закрыт тред или нет
            if (finalCommit) outcome = 'dismissed';
        }
    } catch (error) {
        logError(`${repo.slug}#${prId}: не удалось узнать, чем закончился PR — ${error.message}`);
    }
    if (comments) markResolved(prState, comments, ctx.config.agents);
    const fixes = finalCommit ? pushedFixes(repo.slug, prId) : [];
    for (const finding of prState.findings) {
        const addressed = finalCommit && finding.commit !== finalCommit && resolveCommit(clone, finding.commit) && isAddressed(clone, finding, finalCommit, fixes);
        // У отклонённого PR замечания в метрику не идут, закрыт тред или нет
        record(ctx, repo, prId, finding, addressed ? 'addressed' : outcome);
    }
};
