// Баннеры обзора по важности — как banners в OverviewView.swift. Цвет — по SwiftUI:
// красный — critical, оранжевый — alert, жёлтый — warning, акцентный — info (agents/design/web/components.css)
import { memoryLimit, tokens, workerStall, isRunning, type TokenInfo } from './derive';
import { clock, minutesText, parse, shortDate } from './format';
import type { Prefs } from './prefs';
import type { Data, Lesson } from './types';
import type { SettingsSheet } from '../settings/model';
import { t } from '../i18n';

export type BannerAction = { label: string; destructive?: boolean } & ({ kind: 'settings'; sheet: SettingsSheet } | { kind: 'memory'; slug: string } | { kind: 'stop' } | { kind: 'copy'; text: string } | { kind: 'open'; url: string } | { kind: 'retry' });

export type Banner = {
    id: string;
    variant: 'critical' | 'alert' | 'warning' | 'info';
    icon: string;
    title: string;
    text: string;
    command?: string;
    clamp?: boolean;
    actions: BannerAction[];
    close?: { hint: string; kind: 'token' | 'lessons'; key: string };
};

const isSameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

// Закрытое предупреждение возвращается на следующий день; об истёкшем токене — не закрывается
export const tokenBanners = (all: TokenInfo[], prefs: Prefs, now = new Date()) =>
    all.filter((token) => {
        const closed = parse(prefs.tokenBannerClosedAt[token.id]);
        return token.isExpired || (token.isExpiring && !(closed && isSameDay(closed, now)));
    });

// Свои правила новыми не считаются: их и так видели, когда добавляли
export const newLessons = (lessons: Lesson[], seenAt: string | undefined) => {
    const seen = parse(seenAt);
    if (!seen) return [];
    return lessons.filter((lesson) => lesson.manual !== true && (parse(lesson.at)?.getTime() ?? 0) > seen.getTime());
};

const tokenBanner = (token: TokenInfo): Banner => {
    const date = token.expiresAt ? shortDate(token.expiresAt) : '';
    const title = token.isExpired
        ? t('overview.banners.tokenExpired', { name: token.title, date })
        : token.daysLeft === 0
          ? t('overview.banners.tokenToday', { name: token.title })
          : t('overview.banners.tokenSoon', { name: token.title, count: token.daysLeft ?? 0, date });
    return {
        id: `token-${token.id}`,
        variant: token.isExpired ? 'critical' : 'warning',
        icon: 'i-key-fill',
        title,
        // Слова «Keychain» нет: на Windows секреты хранятся не там
        text: token.id === 'bitbucket' ? t('overview.banners.tokenTextBitbucket') : t('overview.banners.tokenText', { name: token.title }),
        actions: [{ label: t('overview.banners.tokenUpdate'), kind: 'settings', sheet: 'tokens' }],
        close: token.isExpired ? undefined : { hint: t('overview.banners.tokenClose'), kind: 'token', key: token.id },
    };
};

const memoryBanner = (slug: string, count: number, limit: number): Banner => {
    const full = count >= limit;
    // Сверх лимита память бывает, только когда сервису нечего вытеснить
    const overflow = count > limit;
    return {
        id: `memory-${slug}`,
        variant: full ? 'critical' : 'warning',
        icon: 'i-brain',
        title: t(overflow ? 'overview.banners.memoryOverflow' : full ? 'overview.banners.memoryFull' : 'overview.banners.memoryNearlyFull', { repo: slug, count, limit }),
        text: t(overflow ? 'overview.banners.memoryOverflowText' : full ? 'overview.banners.memoryFullText' : 'overview.banners.memoryNearlyFullText'),
        actions: [{ label: t('overview.banners.memoryCheck'), kind: 'memory', slug }],
    };
};

export const banners = (data: Data, prefs: Prefs, extra: { syncError: string | null; memoryBroken: Record<string, string> }, now = new Date()): Banner[] => {
    const result: Banner[] = [];
    const log: BannerAction = { label: t('overview.banners.log'), kind: 'settings', sheet: 'log' };
    const stall = workerStall(data.status, now);
    if (stall)
        result.push({
            id: 'stall',
            variant: 'alert',
            icon: 'i-hourglass',
            title: t('overview.banners.stallTitle', { duration: minutesText(stall.minutes) }),
            text: t('overview.banners.stallText', { time: clock(stall.since) }),
            actions: [log, { label: t('overview.banners.stop'), kind: 'stop', destructive: true }],
        });
    const lastRunError = isRunning(data.status) || data.status?.phase !== 'error' ? null : data.status?.lastError;
    const error = extra.syncError ?? lastRunError;
    if (error)
        result.push({
            id: 'error',
            variant: 'alert',
            icon: 'i-warning-fill',
            title: extra.syncError ? t('overview.banners.commandFailed') : t('overview.banners.lastRunFailed'),
            text: error.trim(),
            clamp: true,
            actions: [log],
        });
    const all = tokenBanners(tokens(data, now), prefs, now);
    result.push(...all.filter((token) => token.isExpired).map(tokenBanner));
    for (const slug of Object.keys(extra.memoryBroken).sort())
        result.push({ id: `broken-${slug}`, variant: 'critical', icon: 'i-brain', title: t('overview.banners.memoryBroken', { repo: slug }), text: extra.memoryBroken[slug], clamp: true, actions: [] });
    result.push(...all.filter((token) => !token.isExpired).map(tokenBanner));
    const limit = memoryLimit(data.config);
    // Репозитории, где память заполнена на 80% и больше: пора просмотреть правила, пока не начали вытесняться правила
    const nearlyFull = data.config.repos.map((repo) => ({ slug: repo.slug, count: data.memory[repo.slug]?.length ?? 0 })).filter(({ count }) => count * 5 >= limit * 4);
    result.push(...nearlyFull.filter(({ count }) => count >= limit).map(({ slug, count }) => memoryBanner(slug, count, limit)));
    result.push(...nearlyFull.filter(({ count }) => count < limit).map(({ slug, count }) => memoryBanner(slug, count, limit)));
    // Баннер закрывается, а подсветка в настройках остаётся до просмотра памяти; следующее новое правило снова покажет баннер
    for (const repo of data.config.repos) {
        const fresh = newLessons(data.memory[repo.slug] ?? [], prefs.memorySeenAt[repo.slug]);
        const closed = parse(prefs.memoryBannerClosedAt[repo.slug])?.getTime() ?? 0;
        if (!fresh.some((lesson) => (parse(lesson.at)?.getTime() ?? 0) > closed)) continue;
        const latest = fresh.reduce((a, b) => (a.at > b.at ? a : b));
        result.push({
            id: `lessons-${repo.slug}`,
            variant: 'info',
            icon: 'i-brain',
            title: t('overview.banners.lessons', { repo: repo.slug, count: fresh.length }),
            text: latest.text,
            clamp: true,
            actions: [{ label: t('overview.banners.lessonsView'), kind: 'memory', slug: repo.slug }],
            close: { hint: t('overview.banners.lessonsClose'), kind: 'lessons', key: repo.slug },
        });
    }
    return result;
};

// Сервис не отвечает — баннер встаёт первым, список PR при этом остаётся, если данные уже были.
// Сервис не установлен (#70) — вместо команды перезапуска ссылка на инструкцию
export const serviceDownBanner = (down: { title: string; text: string; command?: string; guide?: string }): Banner => {
    const first: BannerAction[] = down.command
        ? [{ label: t('overview.banners.copyCommand'), kind: 'copy', text: down.command }]
        : down.guide
          ? [{ label: t('overview.banners.openGuide'), kind: 'open', url: down.guide }]
          : [];
    return {
        id: 'service-down',
        variant: 'critical',
        icon: 'i-power',
        title: down.title,
        text: down.text,
        command: down.command,
        actions: [...first, { label: t('overview.banners.retry'), kind: 'retry' }],
    };
};

// Ещё 1 сообщение, ещё 2 сообщения, ещё 5 сообщений
export const moreMessages = (count: number) => t('overview.banners.more', { count });
