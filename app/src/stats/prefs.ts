// Фильтры, период и переключатели карточек запоминаются между запусками — как @AppStorage statsDays, statsRepo… в StatsView.swift
export type Dimension = 'agent' | 'repo' | 'author';

export type StatsPrefs = {
    days: number;
    repo: string;
    author: string;
    agent: string;
    pass: string;
    densityBy: 'author' | 'repo';
    fateBy: Dimension;
    commentsBy: Dimension;
};

const KEY = 'pr-reviewer.stats';

const defaults = (): StatsPrefs => ({ days: 30, repo: '', author: '', agent: '', pass: '', densityBy: 'author', fateBy: 'agent', commentsBy: 'repo' });

export const loadStatsPrefs = (): StatsPrefs => {
    try {
        return { ...defaults(), ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
    } catch {
        return defaults();
    }
};

export const saveStatsPrefs = (prefs: StatsPrefs) => {
    try {
        localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
        // Без хранилища выбор живёт до перезапуска
    }
};
