// Строки интерфейса по языку (#68). Лист словаря — строка с подстановками {name} или формы числа { one, few, many, other }
export type Lang = 'ru' | 'en';
export type LangSetting = 'system' | Lang;

export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
type Leaf = string | PluralForms;
export type Tree = { [key: string]: Leaf | Tree };

const isPlural = (value: Leaf | Tree): value is PluralForms => typeof value === 'object' && typeof value.other === 'string';

// Английский словарь повторяет русский по ключам, но формы числа у языков свои
export type Messages<T> = { [K in keyof T]: T[K] extends PluralForms ? PluralForms : T[K] extends string ? string : Messages<T[K]> };

type Keys<T, Prefix extends string = ''> = {
    [K in keyof T & string]: T[K] extends PluralForms | string ? `${Prefix}${K}` : Keys<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type Params = Record<string, string | number>;

export const leafKeys = (tree: Tree, prefix = ''): string[] =>
    Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' || isPlural(value) ? [`${prefix}${key}`] : leafKeys(value, `${prefix}${key}.`)));

const lookup = (tree: Tree, key: string): Leaf | undefined => {
    let node: Leaf | Tree | undefined = tree;
    for (const part of key.split('.')) node = node && typeof node === 'object' && !isPlural(node) ? node[part] : undefined;
    return typeof node === 'string' || (node && isPlural(node)) ? node : undefined;
};

const fill = (text: string, params?: Params) => (params ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)) : text);

const pluralRules = new Map<Lang, Intl.PluralRules>();
const rules = (lang: Lang) => {
    if (!pluralRules.has(lang)) pluralRules.set(lang, new Intl.PluralRules(lang));
    return pluralRules.get(lang)!;
};

export const createTranslator = <T extends Tree>(dictionaries: Record<Lang, Tree>, getLang: () => Lang) =>
    (key: Keys<T>, params?: Params): string => {
        const lang = getLang();
        const leaf = lookup(dictionaries[lang], key) ?? lookup(dictionaries.ru, key);
        if (leaf === undefined) return key;
        if (typeof leaf === 'string') return fill(leaf, params);
        const count = Number(params?.count ?? 0);
        return fill(leaf[rules(lang).select(count)] ?? leaf.other, params);
    };
