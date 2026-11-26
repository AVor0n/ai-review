import { describe, expect, it } from 'vitest';
import { errorsLastDay, isLong, logTime } from './log';

const NOW = new Date('2026-11-26T12:00:00Z');
const entry = (hoursAgo: number, isError: boolean) => ({ id: hoursAgo, at: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(), message: 'x', isError });

describe('журнал', () => {
    it('счётчик ошибок за сутки: без ошибок значения нет', () => {
        expect(errorsLastDay([entry(1, false), entry(30, true)], NOW)).toBeNull();
        expect(errorsLastDay([entry(1, true)], NOW)).toBe('1 ошибка за сутки');
        expect(errorsLastDay([entry(1, true), entry(2, true), entry(23, true), entry(25, true)], NOW)).toBe('3 ошибки за сутки');
        expect(errorsLastDay([1, 2, 3, 4, 5].map((hours) => entry(hours, true)), NOW)).toBe('5 ошибок за сутки');
    });

    it('длинная или многострочная запись сворачивается', () => {
        expect(isLong('коротко')).toBe(false);
        expect(isLong('a\nb')).toBe(true);
        expect(isLong('x'.repeat(141))).toBe(true);
    });

    it('время записи — «26 нояб. 14:05:12»', () => {
        expect(logTime(new Date(2026, 10, 26, 14, 5, 12).toISOString())).toBe('26 нояб. 14:05:12');
    });
});
