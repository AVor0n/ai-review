import { plural } from '../model/format';

// Записи журнала сервиса из GET /log: от старых к новым, многострочная запись — одна
export type LogEntry = { id: number; at: string; message: string; isError: boolean };

export const LOG_LIMIT = 300;
const DAY = 24 * 3_600_000;

// Длинная или многострочная запись свёрнута до двух строк — справа шеврон
export const isLong = (message: string) => message.includes('\n') || message.length > 140;

const dayMonth = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' });
const time = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// «26 нояб. 14:05:12»
export const logTime = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : `${dayMonth.format(date)} ${time.format(date)}`;
};

// Число в строке «Журнал»: ошибки за последние 24 часа; без ошибок значения нет
export const errorsLastDay = (entries: LogEntry[], now = new Date()) => {
    const count = entries.filter((entry) => entry.isError && now.getTime() - Date.parse(entry.at) < DAY).length;
    return count ? `${count} ${plural(count, 'ошибка', 'ошибки', 'ошибок')} за сутки` : null;
};
