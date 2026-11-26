// Числа статистики — как money, duration, hours и percent в StatsView.swift
export const money = (value: number | null | undefined) => (value == null ? '—' : `$${value.toFixed(2)}`);

export const duration = (seconds: number) => (seconds < 60 ? `${seconds} с` : seconds < 600 ? `${Math.floor(seconds / 60)} мин ${seconds % 60} с` : `${Math.floor(seconds / 60)} мин`);

// Дробные — с запятой: «2,6»
export const decimal = (value: number, digits = 1) => value.toFixed(digits).replace('.', ',');

export const hours = (value: number) => {
    if (value < 1) return '< 1 ч';
    if (value < 10) return `${decimal(value)} ч`;
    if (value < 48) return `${Math.round(value)} ч`;
    return `${decimal(value / 24)} дн.`;
};

export const percent = (part: number, total: number) => (total > 0 ? `${Math.floor((part * 100) / total)}%` : '—');

// Доля и «сколько/из скольких»: «74% · 118/159»
export const shareText = (part: number, total: number) => (total > 0 ? `${Math.floor((part * 100) / total)}% · ${part}/${total}` : '—');

const MONTHS_SHORT = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
const MONTHS_FULL = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// Подписи дат на осях «2 нояб.» и в подсказке «19 ноября»
export const dayShort = (date: Date) => `${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}`;
export const dayFull = (date: Date) => `${date.getDate()} ${MONTHS_FULL[date.getMonth()]}`;

// «9 важных замечаний» — склонение как в LevelTooltip
const LEVEL_NAMES: Record<string, [string, string]> = { P0: ['критичное', 'критичных'], P1: ['важное', 'важных'], P2: ['среднее', 'средних'], P3: ['мелкое', 'мелких'] };
export const levelCount = (level: string, count: number) => {
    const [one, other] = LEVEL_NAMES[level] ?? ['', ''];
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return `${count} ${one} замечание`;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} ${other} замечания`;
    return `${count} ${other} замечаний`;
};
