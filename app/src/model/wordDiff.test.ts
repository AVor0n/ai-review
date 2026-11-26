import { describe, expect, it } from 'vitest';
import { changeDiff, common, runs, words } from './wordDiff';

describe('WordDiff — как в MemoryReviewView.swift', () => {
    it('слово вместе с пробелами после него, текст собирается обратно', () => {
        expect(words('Модалки  закрывать правильно')).toEqual(['Модалки  ', 'закрывать ', 'правильно']);
        expect(words('a b').join('')).toBe('a b');
    });

    it('общая подпоследовательность по словам без учёта пробелов', () => {
        expect(common(words('a b c'), words('a x c'))).toEqual({ a: new Set([0, 2]), b: new Set([0, 2]) });
    });

    it('пробел между двумя изменёнными словами подсвечен, обратные кавычки — моноширинный код', () => {
        expect(runs(words('было `x` два три'), new Set([0]))).toEqual([
            { text: 'было ', code: false, marked: false },
            { text: 'x', code: true, marked: true },
            { text: ' два три', code: false, marked: true },
        ]);
    });

    it('склеенное правило: новое сравнивается со всеми прежними подряд', () => {
        const diff = changeDiff(['Списки грузятся постранично', 'Выставки тоже'], 'Списки и выставки грузятся постранично');
        expect(diff.before).toHaveLength(2);
        expect(diff.after.filter((run) => run.marked).map((run) => run.text.trim())).toEqual(['и выставки']);
        expect(diff.before[1].every((run) => run.marked)).toBe(true);
    });
});
