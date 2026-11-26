import { formatDate, formatNumber } from '../model/format';
import { t } from '../i18n';

// Числа статистики — как money, duration, hours и percent в StatsView.swift
export const money = (value: number | null | undefined) => (value == null ? '—' : `$${value.toFixed(2)}`);

export const duration = (seconds: number) =>
    seconds < 60 ? t('common.time.seconds', { seconds }) : seconds < 600 ? t('common.time.minutesSeconds', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 }) : t('common.time.minutes', { minutes: Math.floor(seconds / 60) });

// Дробные — по языку: «2,6» / «2.6»
export const decimal = (value: number, digits = 1) => formatNumber(Number(value.toFixed(digits)), { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });

export const hours = (value: number) => {
    if (value < 1) return t('common.time.lessThanHour');
    if (value < 10) return t('common.time.hours', { hours: decimal(value) });
    if (value < 48) return t('common.time.hours', { hours: Math.round(value) });
    return t('common.time.days', { days: decimal(value / 24) });
};

export const percent = (part: number, total: number) => (total > 0 ? `${Math.floor((part * 100) / total)}%` : '—');

// Доля и «сколько/из скольких»: «74% · 118/159»
export const shareText = (part: number, total: number) => (total > 0 ? `${Math.floor((part * 100) / total)}% · ${part}/${total}` : '—');

// Подписи дат на осях «2 нояб.» и в подсказке «19 ноября»
export const dayShort = (date: Date) => formatDate(date, { day: 'numeric', month: 'short' });
export const dayFull = (date: Date) => formatDate(date, { day: 'numeric', month: 'long' });

// «9 важных замечаний»
export const levelCount = (level: string, count: number) => (level === 'P0' || level === 'P1' || level === 'P2' || level === 'P3' ? t(`common.level.${level}`, { count }) : String(count));
