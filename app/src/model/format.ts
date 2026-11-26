import { locale, t } from '../i18n';

// Даты и числа на языке интерфейса — как Dates и plural-функции в menubar/Model.swift
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Форматтеры Intl дорогие: по одному на язык и набор опций
const cache = new Map<string, Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.NumberFormat>();
const cached = <T extends Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.NumberFormat>(kind: string, create: (lang: string) => T): T => {
    const key = `${locale()}:${kind}`;
    if (!cache.has(key)) cache.set(key, create(locale()));
    return cache.get(key) as T;
};
const dates = (options: Intl.DateTimeFormatOptions) => cached(`date:${JSON.stringify(options)}`, (lang) => new Intl.DateTimeFormat(lang, options));
// В английском короткие единицы: «5 min ago», в русском — «5 минут назад»
const relative = () => cached('relative', (lang) => new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: lang === 'ru' ? 'long' : 'short' }));
export const formatDate = (date: Date, options: Intl.DateTimeFormatOptions) => dates(options).format(date);
export const formatNumber = (value: number, options: Intl.NumberFormatOptions = {}) => cached(`number:${JSON.stringify(options)}`, (lang) => new Intl.NumberFormat(lang, options)).format(value);

const time = { hour: '2-digit', minute: '2-digit' } as const;
const dayMonth = { day: 'numeric', month: 'short' } as const;
const dayMonthYear = { day: 'numeric', month: 'short', year: 'numeric' } as const;
const dayLongMonth = { day: 'numeric', month: 'long' } as const;
const full = { dateStyle: 'long', timeStyle: 'short' } as const;
const medium = { dateStyle: 'medium', timeStyle: 'short' } as const;

export const parse = (iso: string | null | undefined): Date | null => {
    if (!iso) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
};

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
const daysBetween = (from: Date, to: Date) => Math.round((startOfDay(to) - startOfDay(from)) / DAY);
const isToday = (date: Date, now: Date) => daysBetween(now, date) === 0;

// «только что», «5 минут назад», «вчера», «2 дня назад»
export const ago = (value: string | Date | null | undefined, now = new Date()): string => {
    const date = value instanceof Date ? value : parse(value);
    if (!date) return '—';
    const passed = now.getTime() - date.getTime();
    if (passed < MINUTE) return t('common.time.justNow');
    if (passed < HOUR) return relative().format(-Math.floor(passed / MINUTE), 'minute');
    if (passed < DAY) return relative().format(-Math.floor(passed / HOUR), 'hour');
    const days = daysBetween(date, now);
    if (days < 30) return relative().format(-days, 'day');
    if (days < 365) return relative().format(-Math.floor(days / 30), 'month');
    return relative().format(-Math.floor(days / 365), 'year');
};

export const clock = (date: Date) => formatDate(date, time);

// Сброс лимита: «до 14:00» сегодня, «до завтра 14:00», дальше — «до 31 окт.»
export const resetShort = (date: Date, now = new Date()) => {
    const days = daysBetween(now, date);
    if (days === 0) return t('common.time.until', { time: clock(date) });
    if (days === 1) return t('common.time.untilTomorrow', { time: clock(date) });
    return t('common.time.until', { time: formatDate(date, dayMonth) });
};

// «25 ноября в 14:30»
export const resetFull = (date: Date) => t('common.time.dateAtTime', { date: formatDate(date, dayLongMonth), time: clock(date) });

// «25 ноября 2026 г. в 14:00»
export const fullDate = (date: Date) => formatDate(date, full);

// Срок токена: год — только если не текущий
export const shortDate = (date: Date, now = new Date()) => formatDate(date, date.getFullYear() === now.getFullYear() ? dayMonth : dayMonthYear);

// Срок паузы уведомлений: время сегодня, иначе дата и время
export const moment = (date: Date, now = new Date()) => (isToday(date, now) ? clock(date) : formatDate(date, medium));

export const minutesText = (minutes: number) => (minutes >= 60 ? t('common.time.hoursMinutes', { hours: Math.floor(minutes / 60), minutes: minutes % 60 }) : t('common.time.minutes', { minutes }));

// Короткое имя в подписях: без общей части имён репозиториев из настройки displayPrefix
export const shortRepoName = (slug: string, prefix?: string) => (prefix && slug.startsWith(prefix) && slug.length > prefix.length ? slug.slice(prefix.length) : slug);

export const roleName = (role: string) => (role === 'first' || role === 'second' || role === 'replies' ? t(`common.role.${role}`) : role);

export const daysBetweenDates = daysBetween;
