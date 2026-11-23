import { plural } from './lesson-usage.mjs';
import { log, logError } from './store.mjs';

// Итог ревью статусом сборки на голове PR (B-26): автор видит, что ревью было, даже когда замечаний нет.
// FAILED не ставим — ревью не блокирует слияние; запись обновляется повторным POST с тем же key
export const STATUS_KEY = 'pr-reviewer';
const STATUS_NAME = 'PR Reviewer';
const MAX_DESCRIPTION = 250;

const SKIP_TEXTS = {
    rebase: 'изменения те же, что на прошлом ревью (rebase или слияние целевой ветки)',
    ignored: 'в диффе только исключённые файлы',
    empty: 'в PR нет изменений относительно целевой ветки',
};

// buildStatus.prs — «slug#id»: статус пишется только этим PR (первая живая проверка); без списка — всем
export const buildStatusEnabled = (config, repo, pr) => {
    const settings = config.buildStatus;
    if (!settings?.enabled) return false;
    return !settings.prs?.length || settings.prs.includes(`${repo.slug}#${pr.id}`);
};

const day = (date) => `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}`;

// review — { agents: {agentId: {P0..P3}} } по текущей голове; failed — модели, чей запуск в этот раз не удался;
// limited — {agentId: Date} модели с исчерпанным лимитом: они не «не удались», а ждут сброса
export const summaryText = (review, agents, failed = [], limited = {}) => {
    const ids = Object.keys(review?.agents ?? {});
    const failedNames = failed.filter((id) => !limited[id]).map((id) => agents[id]?.shortName ?? id);
    const limitLine = Object.entries(limited).map(([id, until]) => `${agents[id]?.shortName ?? id} — лимит до ${day(until)}`).join(', ');
    if (!ids.length && !failedNames.length && limitLine) return `Ревью не было: ${limitLine}`;
    if (!ids.length) return failedNames.length ? `Ревью не удалось (${failedNames.join(', ')}), повторим на следующем проходе` : 'Ревью не удалось, повторим на следующем проходе';
    const totals = { P0: 0, P1: 0, P2: 0, P3: 0 };
    for (const counts of Object.values(review.agents)) for (const level of Object.keys(totals)) totals[level] += counts?.[level] ?? 0;
    const levels = Object.entries(totals).filter(([, count]) => count).map(([level, count]) => `${level}: ${count}`);
    const names = ids.map((id) => agents[id]?.shortName ?? id).join(', ');
    const failedLine = failedNames.length ? ` · не удалось: ${failedNames.join(', ')}` : '';
    return `${plural(ids.length, ['модель', 'модели', 'моделей'])} (${names}): ${levels.length ? `замечания ${levels.join(', ')}` : 'замечаний нет'}${failedLine}${limitLine ? ` · ${limitLine}` : ''}`;
};

export const skipText = (reason, previous, agents) => {
    const text = SKIP_TEXTS[reason] ?? reason;
    return reason === 'rebase' && previous ? `Ревью не нужно: ${text}. Итог прошлого ревью — ${summaryText(previous, agents)}` : `Ревью не нужно: ${text}`;
};

// Ошибка записи статуса не роняет ревью: только журнал. true — статус записан
export const postBuildStatus = async (ctx, repo, pr, commit, state, description) => {
    if (ctx.dryRun || !buildStatusEnabled(ctx.config, repo, pr)) return false;
    const body = {
        key: STATUS_KEY,
        state,
        name: STATUS_NAME,
        url: pr.links.html.href,
        description: description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION - 1)}…` : description,
    };
    try {
        await ctx.bitbucket.postBuildStatus(repo, commit, body);
        log(`${repo.slug}#${pr.id}: статус сборки ${state} — ${body.description}`);
        return true;
    } catch (error) {
        logError(`${repo.slug}#${pr.id}: не удалось записать статус сборки — ${error.message}`);
        return false;
    }
};
