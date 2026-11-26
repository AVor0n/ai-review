import { describe, expect, it } from 'vitest';
import { createTranslator, leafKeys, type Tree } from './core';
import { en } from './en';
import { ru } from './ru';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
const texts = (value: unknown): string[] => (typeof value === 'string' ? [value] : Object.values(value as object).flatMap(texts));
const leaf = (tree: Tree, key: string) => key.split('.').reduce<unknown>((node, part) => (node as Tree)[part], tree);

describe('словари', () => {
    it('ключи ru и en совпадают', () => {
        expect(leafKeys(en as Tree).sort()).toEqual(leafKeys(ru as Tree).sort());
    });

    it('подстановки в ru и en одни и те же', () => {
        for (const key of leafKeys(ru as Tree)) {
            const names = (tree: Tree) => [...new Set(texts(leaf(tree, key)).flatMap(placeholders))].sort();
            expect(names(en as Tree), key).toEqual(names(ru as Tree));
        }
    });

    it('в английском словаре нет кириллицы, кроме названия языка', () => {
        const russian = leafKeys(en as Tree).filter((key) => key !== 'common.language.ru' && texts(leaf(en as Tree, key)).some((text) => /[А-Яа-яЁё]/.test(text)));
        expect(russian).toEqual([]);
    });
});

describe('перевод', () => {
    const dictionaries = {
        ru: { pr: { one: '{count} PR', few: '{count} PR', many: '{count} PR', other: '{count} PR' }, comment: { one: '{count} замечание', few: '{count} замечания', many: '{count} замечаний', other: '{count} замечания' }, hello: 'Привет, {name}' },
        en: { pr: { one: '{count} PR', other: '{count} PRs' }, comment: { one: '{count} comment', other: '{count} comments' }, hello: 'Hi, {name}' },
    };

    it('формы числа по правилам языка', () => {
        const ruT = createTranslator<typeof dictionaries.ru>(dictionaries, () => 'ru');
        const enT = createTranslator<typeof dictionaries.ru>(dictionaries, () => 'en');
        expect([1, 2, 5, 11, 21, 22].map((count) => ruT('comment', { count }))).toEqual(['1 замечание', '2 замечания', '5 замечаний', '11 замечаний', '21 замечание', '22 замечания']);
        expect([1, 2].map((count) => enT('pr', { count }))).toEqual(['1 PR', '2 PRs']);
        expect(enT('hello', { name: 'Ann' })).toBe('Hi, Ann');
    });
});
