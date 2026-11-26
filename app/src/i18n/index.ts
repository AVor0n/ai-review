import { createElement, Fragment, useSyncExternalStore, type ReactNode } from 'react';
import { createTranslator, type Lang, type LangSetting, type Params } from './core';
import { en } from './en';
import { ru } from './ru';

export type { Lang, LangSetting } from './core';

// Выбор хранится в config.json (language), а копия здесь — чтобы при запуске до ответа сервиса и в окне просмотра язык был тот же
const KEY = 'pr-reviewer.language';

export const systemLang = (): Lang => {
    const preferred = typeof navigator === 'undefined' ? [] : (navigator.languages?.length ? navigator.languages : [navigator.language]);
    return preferred[0]?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
};

export const resolveLang = (setting: LangSetting | undefined | null): Lang => (setting === 'ru' || setting === 'en' ? setting : systemLang());

export const loadLangSetting = (): LangSetting => {
    try {
        const value = localStorage.getItem(KEY);
        return value === 'ru' || value === 'en' ? value : 'system';
    } catch {
        return 'system';
    }
};

// Вне окна (тесты) — русский: на нём написаны проверки текстов
let setting: LangSetting = loadLangSetting();
let current: Lang = typeof window === 'undefined' ? 'ru' : resolveLang(setting);
const listeners = new Set<() => void>();

// Rust пишет на этом языке свои ошибки и стартовое меню трея
const tellNative = (lang: Lang) => {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_language', { lang })).catch(() => {});
};
tellNative(current);
if (typeof document !== 'undefined') document.documentElement.lang = current;

const apply = (next: LangSetting, lang: Lang) => {
    if (next === setting && lang === current) return;
    setting = next;
    current = lang;
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
    tellNative(lang);
    for (const listener of listeners) listener();
};

export const setLangSetting = (next: LangSetting) => {
    try {
        localStorage.setItem(KEY, next);
    } catch {
        // Без хранилища выбор живёт до перезапуска, а дальше приходит из config.json
    }
    apply(next, resolveLang(next));
};

// Тесты и окно просмотра: язык напрямую, без сохранения
export const setLang = (lang: Lang) => apply(setting, lang);

export const getLang = () => current;
export const getLangSetting = () => setting;

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    return () => {
        listeners.delete(listener);
    };
};

// Поповер и окно просмотра — разные страницы: язык, выбранный в одной, подхватывает другая
const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) apply(loadLangSetting(), resolveLang(loadLangSetting()));
};

// Компонент, у которого тексты посчитаны заранее (useMemo, состояние), берёт язык отсюда — и пересчитывает их при смене
export const useLang = () => useSyncExternalStore(subscribe, getLang);
export const useLangSetting = () => useSyncExternalStore(subscribe, getLangSetting);

export const t = createTranslator<typeof ru>({ ru, en }, getLang);
export type MessageKey = Parameters<typeof t>[0];

// Строка с вставками-элементами: tx('a.b', { link: <a …/> }) → ['Текст ', <a …/>, '.']
export const tx = (key: MessageKey, params: Record<string, ReactNode>): ReactNode[] => {
    const text = t(key, Object.fromEntries(Object.entries(params).filter((entry): entry is [string, string | number] => typeof entry[1] === 'string' || typeof entry[1] === 'number')) as Params);
    return text.split(/\{(\w+)\}/).map((part, index) => (index % 2 === 0 ? part : createElement(Fragment, { key: index }, params[part] ?? `{${part}}`)));
};

// Локаль для Intl: даты, время, числа. Английский — en-GB: 24 часа и «27 Nov», как в спецификации дизайнера
export const locale = () => (current === 'en' ? 'en-GB' : 'ru');
