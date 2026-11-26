// Баннеры обзора по важности — как banners в OverviewView.swift. Цвет — по SwiftUI:
// красный — critical, оранжевый — alert, жёлтый — warning, акцентный — info (product/design/web/components.css)
import { memoryLimit, tokens, workerStall, isRunning, type TokenInfo } from './derive';
import { clock, minutesText, parse, plural, shortDate } from './format';
import type { Prefs } from './prefs';
import type { Data, Lesson } from './types';
import type { StubTarget } from './stubs';

export type BannerAction = { label: string; destructive?: boolean } & ({ kind: 'stub'; target: StubTarget } | { kind: 'memory'; slug: string } | { kind: 'stop' } | { kind: 'copy'; text: string } | { kind: 'retry' });

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
    const title = token.isExpired ? `Токен ${token.title} истёк ${date}` : token.daysLeft === 0 ? `Токен ${token.title} истекает сегодня` : `Токен ${token.title} истекает через ${token.daysLeft ?? 0} дн. — ${date}`;
    const impact = token.id === 'bitbucket' ? 'Без него фоновое ревью не видит PR и не публикует комментарии.' : `Без него ${token.title} не сможет ревьюить в фоне.`;
    return {
        id: `token-${token.id}`,
        variant: token.isExpired ? 'critical' : 'warning',
        icon: 'i-key-fill',
        title,
        // Слова «Keychain» нет: на Windows секреты хранятся не там
        text: `${impact} Выпустите новый и сохраните — срок обновится сам.`,
        actions: [{ label: 'Обновить…', kind: 'stub', target: { kind: 'token', id: token.id, title: token.title, lifetimeDays: token.lifetimeDays } }],
        close: token.isExpired ? undefined : { hint: 'Скрыть до завтра', kind: 'token', key: token.id },
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
        title: overflow ? `Память ${slug} переполнена: ${count} из ${limit}` : full ? `Память ${slug} заполнена: ${count} из ${limit}` : `Память ${slug} почти заполнена: ${count} из ${limit}`,
        text: overflow
            ? 'Вытеснять нечего: все правила добавлены или исправлены вручную либо выучены недавно. Удалите лишние или поднимите memory.maxLessons в config.json.'
            : full
              ? 'Новые правила вытесняют наименее полезные автоматические. Удалите лишние или поправьте нужные — исправленные вручную не вытесняются.'
              : 'Скоро новые правила начнут вытеснять наименее полезные. Просмотрите память: удалите лишнее, поправьте нужное — исправленные вручную правила не вытесняются.',
        actions: [{ label: 'Проверить правила', kind: 'memory', slug }],
    };
};

export const banners = (data: Data, prefs: Prefs, extra: { syncError: string | null; memoryBroken: Record<string, string> }, now = new Date()): Banner[] => {
    const result: Banner[] = [];
    const log: BannerAction = { label: 'Журнал', kind: 'stub', target: { kind: 'tab', tab: 'log' } };
    const stall = workerStall(data.status, now);
    if (stall)
        result.push({
            id: 'stall',
            variant: 'alert',
            icon: 'i-hourglass',
            title: `Проход ревью не продвигается ${minutesText(stall.minutes)}`,
            text: `Сервис не подаёт признаков жизни, последняя запись в журнале — в ${clock(stall.since)}. Похоже, завис git или сеть. «Прервать» остановит этот проход, следующий начнётся по расписанию.`,
            actions: [log, { label: 'Прервать', kind: 'stop', destructive: true }],
        });
    const lastRunError = isRunning(data.status) || data.status?.phase !== 'error' ? null : data.status?.lastError;
    const error = extra.syncError ?? lastRunError;
    if (error)
        result.push({
            id: 'error',
            variant: 'alert',
            icon: 'i-warning-fill',
            title: extra.syncError ? 'Не удалось выполнить команду' : 'Последний запуск завершился с ошибкой',
            text: error.trim(),
            clamp: true,
            actions: [log],
        });
    const all = tokenBanners(tokens(data, now), prefs, now);
    result.push(...all.filter((token) => token.isExpired).map(tokenBanner));
    for (const slug of Object.keys(extra.memoryBroken).sort())
        result.push({ id: `broken-${slug}`, variant: 'critical', icon: 'i-brain', title: `Память ${slug} повреждена — ревью идёт без её правил`, text: extra.memoryBroken[slug], clamp: true, actions: [] });
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
            title: `Новые правила в памяти ${repo.slug}: ${fresh.length}`,
            text: latest.text,
            clamp: true,
            actions: [{ label: 'Посмотреть', kind: 'memory', slug: repo.slug }],
            close: { hint: 'Скрыть баннер. Подсветка памяти в настройках останется, пока вы её не откроете', kind: 'lessons', key: repo.slug },
        });
    }
    return result;
};

// Сервис не отвечает — баннер встаёт первым, список PR при этом остаётся, если данные уже были
export const serviceDownBanner = (down: { text: string; command: string }): Banner => ({
    id: 'service-down',
    variant: 'critical',
    icon: 'i-power',
    title: 'Сервис не запущен',
    text: down.text,
    command: down.command,
    actions: [
        { label: 'Скопировать команду', kind: 'copy', text: down.command },
        { label: 'Проверить снова', kind: 'retry' },
    ],
});

// Ещё 1 сообщение, ещё 2 сообщения, ещё 5 сообщений
export const moreMessages = (count: number) => `Ещё ${count} ${plural(count, 'сообщение', 'сообщения', 'сообщений')}`;
