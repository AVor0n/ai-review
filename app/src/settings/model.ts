import { t } from '../i18n';
import { ago, clock, formatDate, moment as momentShort, parse, resetFull, shortDate } from '../model/format';
import type { TokenInfo } from '../model/derive';
import type { AgentConfig, Limit } from '../model/types';

// Логика вкладки «Настройки» без разметки — перенос IntervalRow, AgentRow, TokensRow, TokensSheet и ConfigSchema из menubar/*.swift
export type SettingsSheet = 'notifications' | 'tokens' | 'branches' | 'add-repo' | 'ignore' | 'config' | 'log';
export type Option = { id: string; title: string };

// Шаги степпера: мелкие значения нужны редко, поэтому шкала разреженная
export const INTERVALS = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];
export const stepInterval = (current: number, direction: 1 | -1) =>
    direction > 0 ? INTERVALS.find((value) => value > current) : [...INTERVALS].reverse().find((value) => value < current);

// Псевдоним opus всегда указывает на последнюю Opus; остальные — конкретные версии
export const claudeModels = () => [
    { id: 'opus', title: t('settings.models.opusLatest'), label: 'Claude Opus' },
    { id: 'claude-opus-5-5', title: 'Opus 5.5', label: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', title: 'Sonnet 5.5', label: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-5-5', title: 'Haiku 5.5', label: 'Claude Haiku 5.5' },
    { id: 'claude-fable-5-1', title: 'Fable 5.1', label: 'Claude Fable 5.1' },
];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export type CodexModel = { slug: string; display_name: string; visibility?: string; default_reasoning_level?: string | null; supported_reasoning_levels?: { effort: string }[] | null };
export type Models = { codex: CodexModel[]; cursor: Option[] };

export const parseModels = (raw: { codex?: { models?: CodexModel[] } | null; cursor?: { models?: Option[] } | null } | undefined): Models => ({
    codex: (raw?.codex?.models ?? []).filter((model) => model.visibility === 'list'),
    cursor: raw?.cursor?.models ?? [],
});

const codexEfforts = (model: CodexModel | undefined) => model?.supported_reasoning_levels?.map((level) => level.effort) ?? ['low', 'medium', 'high'];

// Модель из конфига, которой нет в списке, всё равно показываем первой — иначе меню выглядело бы пустым
export const modelOptions = (id: string, current: string, models: Models): Option[] => {
    const known: Option[] = id === 'claude' ? claudeModels() : id === 'cursor' ? models.cursor : models.codex.map((model) => ({ id: model.slug, title: model.display_name }));
    return !current || known.some((option) => option.id === current) ? known : [{ id: current, title: current }, ...known];
};

export const effortOptions = (id: string, current: string, models: Models): Option[] =>
    id === 'claude'
        ? [{ id: 'default', title: t('settings.models.defaultEffort') }, ...CLAUDE_EFFORTS.map((effort) => ({ id: effort, title: effort }))]
        : codexEfforts(models.codex.find((model) => model.slug === current)).map((effort) => ({ id: effort, title: effort }));

export const currentEffort = (id: string, agent: AgentConfig | undefined) => (id === 'claude' ? (agent?.effort ?? 'default') : (agent?.reasoningEffort ?? ''));

// Что отправить сервису при выборе модели: подпись для комментариев и, у Codex, уровень, если новая модель его не поддерживает
export const modelChange = (id: string, value: string, agent: AgentConfig | undefined, models: Models) => {
    if (id === 'claude') return { model: value, label: claudeModels().find((model) => model.id === value)?.label };
    if (id === 'cursor') {
        const title = models.cursor.find((model) => model.id === value)?.title;
        return { model: value, label: title ? `Cursor ${title}` : undefined };
    }
    const codex = models.codex.find((model) => model.slug === value);
    const efforts = codexEfforts(codex);
    const effort = codex && !efforts.includes(currentEffort(id, agent)) ? (codex.default_reasoning_level ?? efforts[efforts.length - 1]) : undefined;
    return { model: value, effort, label: codex ? `Codex ${codex.display_name}` : undefined };
};

// Codex и Cursor отдают лимиты по сети; Claude пишет их сам при каждом запуске
export const POLLED_LIMITS = ['codex', 'cursor'];
const HOUR = 3_600_000;

export type LimitView = { bar: number | null; stale: boolean; warning: boolean; text: string; low: boolean; none: boolean; hint: string };

const moment = (date: Date | null, now: Date) => (date ? momentShort(date, now) : '—');
const momentFull = (date: Date | null) => (date ? resetFull(date) : '—');
const errorText = (error: NonNullable<Limit['error']>) => ([401, 403].includes(error.code ?? 0) ? t('settings.limit.errorCode', { code: error.code ?? 0, text: error.text }) : error.text);

// Строка лимита под именем модели — те же правила свежести и подсказки, что у AgentRow
export const limitView = (id: string, limit: Limit | undefined, agentName: string, now = new Date()): LimitView => {
    const blank = { bar: null, stale: false, warning: false, low: false, none: false, hint: '' };
    if (!limit) return { ...blank, none: true, text: POLLED_LIMITS.includes(id) ? t('settings.limit.unavailable') : t('settings.limit.afterRun') };
    const remaining = Math.max(0, 100 - limit.usedPercent);
    const percent = `${Math.round(remaining)}%`;
    const updatedAt = parse(limit.at);
    const resetsAt = parse(limit.resetsAt);
    const window = limit.window === 'month' ? 'month' : 'week';
    const regular = resetsAt ? t(`settings.limit.leftUntil.${window}`, { percent, date: formatDate(resetsAt, { day: 'numeric', month: 'short' }) }) : t(`settings.limit.left.${window}`, { percent });
    const reset = resetsAt !== null && resetsAt <= now;
    // Лимит без опроса (Claude) приходит только с запусков модели: старые данные — норма, а не сбой, поэтому полоса остаётся цветной
    if (!POLLED_LIMITS.includes(id)) {
        if (reset) return { ...blank, text: t('settings.limit.reset'), hint: t('settings.limit.resetHint', { reset: momentFull(resetsAt), agent: agentName }) };
        return {
            ...blank,
            bar: remaining,
            low: remaining < 15,
            text: regular,
            hint: t('settings.limit.ownHint', { at: momentFull(updatedAt), agent: agentName }),
        };
    }
    const fresh = !limit.error && updatedAt !== null && now.getTime() - updatedAt.getTime() < HOUR && !reset;
    if (fresh) {
        return { ...blank, bar: remaining, low: remaining < 15, text: regular, hint: t(`settings.limit.freshHint.${window}`, { reset: momentFull(resetsAt), ago: ago(limit.at, now) }) };
    }
    // Неудачный опрос не стирает прошлый остаток, поэтому старое значение помечается, а после сброса не показывается вовсе
    const attempt = parse(limit.errorAt) ? t('settings.limit.lastAttempt', { at: moment(parse(limit.errorAt), now) }) : '';
    if (reset) {
        return limit.error
            ? { ...blank, warning: true, text: t('settings.limit.resetFailed'), hint: t('settings.limit.resetFailedHint', { reset: momentFull(resetsAt), error: errorText(limit.error), attempt }) }
            : { ...blank, text: t('settings.limit.resetPending') };
    }
    if (limit.error) {
        return {
            ...blank,
            bar: remaining,
            stale: true,
            warning: true,
            text: t('settings.limit.failed', { percent, at: moment(updatedAt, now) }),
            hint: t('settings.limit.failedHint', { error: errorText(limit.error), attempt, at: momentFull(updatedAt) }),
        };
    }
    return { ...blank, bar: remaining, stale: true, text: t('settings.limit.stale', { percent, at: moment(updatedAt, now) }), hint: t('settings.limit.staleHint', { at: momentFull(updatedAt) }) };
};

export const limitColor = (view: LimitView) => (view.stale ? 'var(--label-3)' : (view.bar ?? 100) < 15 ? 'var(--orange)' : (view.bar ?? 100) < 40 ? 'var(--yellow)' : 'var(--green)');

// Значение строки «Токены» — ближайшее истечение; предупреждение окрашивает строку так же, как баннер в обзоре
export const tokensSummary = (all: TokenInfo[], now = new Date()): { text: string; color: string | null } => {
    const expired = all.find((token) => token.isExpired);
    if (expired) return { text: t('settings.tokens.expired', { token: expired.title }), color: 'var(--red)' };
    const expiring = all.filter((token) => token.isExpiring).sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))[0];
    if (expiring) return { text: t('settings.tokens.daysLeft', { token: expiring.title, count: expiring.daysLeft ?? 0 }), color: 'var(--orange)' };
    const nearest = all.map((token) => token.expiresAt).filter((date): date is Date => date !== null).sort((a, b) => a.getTime() - b.getTime())[0];
    return nearest ? { text: t('settings.tokens.until', { date: shortDate(nearest, now) }), color: null } : { text: String(all.length), color: null };
};

export const lifetimes = (): Option[] => [
    ...[30, 90, 180].map((count) => ({ id: String(count), title: t('settings.tokens.lifetimeDays', { count }) })),
    { id: '365', title: t('settings.tokens.lifetimeYear') },
    { id: '0', title: t('settings.tokens.lifetimeNone') },
];

export const lifetimeOptions = (lifetimeDays: number | null): Option[] => {
    const all = lifetimes();
    if (lifetimeDays === null) return [{ id: 'unset', title: t('settings.tokens.lifetimeUnset') }, ...all];
    return all.some((option) => option.id === String(lifetimeDays)) ? all : [{ id: String(lifetimeDays), title: t('settings.tokens.lifetimeCustom', { count: lifetimeDays }) }, ...all];
};

export const tokenStatus = (token: TokenInfo, savedAt: Date | null, now = new Date()): { text: string; color: string | null } => {
    if (!savedAt) return { text: t('settings.tokens.notSaved'), color: 'var(--red)' };
    const saved = shortDate(savedAt, now);
    if (token.lifetimeDays === null) return { text: t('settings.tokens.noLifetime', { saved }), color: null };
    if (token.lifetimeDays <= 0 || !token.expiresAt) return { text: t('settings.tokens.unlimited', { saved }), color: null };
    const date = shortDate(token.expiresAt, now);
    if (token.isExpired) return { text: t('settings.tokens.expiredOn', { saved, date }), color: 'var(--red)' };
    return { text: t('settings.tokens.activeUntil', { saved, date, count: token.daysLeft ?? 0 }), color: token.isExpiring ? 'var(--orange)' : null };
};

export const ISSUE_URLS: Record<string, string> = {
    bitbucket: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    cursor: 'https://cursor.com/dashboard?tab=integrations',
};

// Значение не попадает в историю шелла и не обрезается: у интерактивного `security … -w` предел 128 символов.
// На Windows токены хранит сервис в WSL — команда CLI для терминала Ubuntu
export const saveCommand = (token: TokenInfo, service: string | undefined, account: string, platform: 'mac' | 'win', cli: string) =>
    platform === 'win'
        ? `${cli} secret set ${token.id}`
        : `read -rs 'TOKEN?${t('settings.tokens.prompt', { token: token.title })}' && security add-generic-password -U -s ${service ?? ''} -a ${account} -T /usr/bin/security -w "$TOKEN"; unset TOKEN`;

export const isValidPattern = (pattern: string) => {
    if (!pattern) return false;
    try {
        new RegExp(pattern, 'i');
        return true;
    } catch {
        return false;
    }
};

// Путь к полю под курсором: ключи объектов и null для элементов массивов. Лёгкий проход по тексту до курсора — работает и на недописанном JSON
export const configPath = (text: string, caret: number): (string | null)[] => {
    type Frame = { object: true; key: string | null } | { object: false };
    const stack: Frame[] = [];
    let expectKey = false;
    for (let index = 0; index < Math.min(caret, text.length); index++) {
        const char = text[index];
        if (char === '"') {
            let end = index + 1;
            let key = '';
            while (end < text.length && text[end] !== '"') {
                if (text[end] === '\\') end++;
                if (end < text.length) key += text[end];
                end++;
            }
            const top = stack[stack.length - 1];
            if (expectKey && top?.object) {
                stack[stack.length - 1] = { object: true, key };
                expectKey = false;
            }
            index = end;
        } else if (char === '{') {
            stack.push({ object: true, key: null });
            expectKey = true;
        } else if (char === '[') stack.push({ object: false });
        else if (char === '}' || char === ']') stack.pop();
        else if (char === ',' && stack[stack.length - 1]?.object) {
            stack[stack.length - 1] = { object: true, key: null };
            expectKey = true;
        }
    }
    const path: (string | null)[] = [];
    for (const frame of stack) {
        if (!frame.object) path.push(null);
        else if (frame.key === null) return path;
        else path.push(frame.key);
    }
    return path;
};

export const pathTitle = (path: (string | null)[]) => path.reduce<string>((result, key) => (key === null ? `${result}[]` : result ? `${result}.${key}` : key), '');

type SchemaNode = { $ref?: string; description?: string; properties?: Record<string, SchemaNode>; additionalProperties?: SchemaNode | boolean; items?: SchemaNode; definitions?: Record<string, SchemaNode> };

// У элемента массива или вложенного поля без своего описания показываем описание ближайшего родителя
export const fieldDescription = (schema: unknown, path: (string | null)[]) => {
    const root = schema as SchemaNode;
    const resolve = (node: SchemaNode): SchemaNode => {
        const name = node.$ref?.split('/').pop();
        const definition = name ? root.definitions?.[name] : undefined;
        return definition ? { ...definition, ...node, $ref: undefined } : node;
    };
    let node: SchemaNode | undefined = root;
    let found: string | undefined;
    for (const key of path) {
        if (!node) break;
        const current: SchemaNode = resolve(node);
        const next: SchemaNode | undefined =
            key === null ? current.items : (current.properties?.[key] ?? (typeof current.additionalProperties === 'object' ? current.additionalProperties : undefined));
        node = next ? resolve(next) : undefined;
        found = node?.description ?? found;
    }
    return found ?? null;
};

// «Сборка 3694b44 · 25.11 14:05», с годом — если не текущий
export const buildInfo = (commit: string, iso: string, dirty: boolean, now = new Date()) => {
    const date = parse(iso);
    if (!date) return null;
    const day = formatDate(date, date.getFullYear() === now.getFullYear() ? { day: '2-digit', month: '2-digit' } : { day: '2-digit', month: '2-digit', year: 'numeric' });
    const when = `${day} ${clock(date)}`;
    const full = t('common.time.dateAtTime', { date: formatDate(date, { day: 'numeric', month: 'long', year: 'numeric' }).replace(/ г\.$/, ''), time: clock(date) });
    return {
        text: commit ? t('settings.build.commit', { commit: commit.slice(0, 7), when }) : t('settings.build.date', { when }),
        dirty: !!commit && dirty,
        hint: !commit ? t('settings.build.hint', { when: full }) : dirty ? t('settings.build.hintDirty', { when: full, commit }) : t('settings.build.hintCommit', { when: full, commit }),
    };
};
