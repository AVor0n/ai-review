// Даты и числа по-русски — как Dates и plural-функции в menubar/Model.swift
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const relative = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
const time = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' });
const dayMonth = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' });
const dayMonthYear = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', year: 'numeric' });
const dayLongMonth = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' });
const full = new Intl.DateTimeFormat('ru', { dateStyle: 'long', timeStyle: 'short' });
const medium = new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' });

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
    if (passed < MINUTE) return 'только что';
    if (passed < HOUR) return relative.format(-Math.floor(passed / MINUTE), 'minute');
    if (passed < DAY) return relative.format(-Math.floor(passed / HOUR), 'hour');
    const days = daysBetween(date, now);
    if (days < 30) return relative.format(-days, 'day');
    if (days < 365) return relative.format(-Math.floor(days / 30), 'month');
    return relative.format(-Math.floor(days / 365), 'year');
};

export const clock = (date: Date) => time.format(date);

// Сброс лимита: «до 14:00» сегодня, «до завтра 14:00», дальше — «до 31 окт.»
export const resetShort = (date: Date, now = new Date()) => {
    const days = daysBetween(now, date);
    if (days === 0) return `до ${clock(date)}`;
    if (days === 1) return `до завтра ${clock(date)}`;
    return `до ${dayMonth.format(date)}`;
};

// «25 ноября в 14:30»
export const resetFull = (date: Date) => `${dayLongMonth.format(date)} в ${clock(date)}`;

// «25 ноября 2026 г. в 14:00»
export const fullDate = (date: Date) => full.format(date);

// Срок токена: год — только если не текущий
export const shortDate = (date: Date, now = new Date()) => (date.getFullYear() === now.getFullYear() ? dayMonth : dayMonthYear).format(date);

// Срок паузы уведомлений: время сегодня, иначе дата и время
export const moment = (date: Date, now = new Date()) => (isToday(date, now) ? clock(date) : medium.format(date));

export const minutesText = (minutes: number) => (minutes >= 60 ? `${Math.floor(minutes / 60)} ч ${minutes % 60} мин` : `${minutes} мин`);

// plural(5, 'сообщение', 'сообщения', 'сообщений') → «сообщений»
export const plural = (count: number, one: string, few: string, many: string) => {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
};

// Короткое имя в подписях: без общей части имён репозиториев из настройки displayPrefix
export const shortRepoName = (slug: string, prefix?: string) => (prefix && slug.startsWith(prefix) && slug.length > prefix.length ? slug.slice(prefix.length) : slug);

export const roleName = (role: string) => ({ first: 'первым', second: 'следом', replies: 'ответы' })[role] ?? role;

export const daysBetweenDates = daysBetween;
