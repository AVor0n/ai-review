// Личные настройки приложения — как UserDefaults в SwiftUI: свёрнутые репозитории, закрытые баннеры,
// просмотренная память, пауза уведомлений. Живут в localStorage вебвью, а не в config.json сервиса
export type Prefs = {
    collapsedRepos: string[];
    tokenBannerClosedAt: Record<string, string>;
    memorySeenAt: Record<string, string>;
    memoryBannerClosedAt: Record<string, string>;
    // ISO-время или «forever» — пока не включат вручную
    mutedUntil: string | null;
};

const KEY = 'pr-reviewer.prefs';

export const defaultPrefs = (): Prefs => ({ collapsedRepos: [], tokenBannerClosedAt: {}, memorySeenAt: {}, memoryBannerClosedAt: {}, mutedUntil: null });

export const loadPrefs = (): Prefs => {
    try {
        return { ...defaultPrefs(), ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
    } catch {
        return defaultPrefs();
    }
};

export const savePrefs = (prefs: Prefs) => {
    try {
        localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
        // Без хранилища настройки живут до перезапуска
    }
};

// Новый репозиторий (и первый запуск) начинают с «всё просмотрено» — иначе все старые правила разом стали бы новыми
export const withSeenRepos = (prefs: Prefs, slugs: string[], now = new Date()): Prefs => {
    const unseen = slugs.filter((slug) => !prefs.memorySeenAt[slug]);
    if (!unseen.length) return prefs;
    return { ...prefs, memorySeenAt: { ...prefs.memorySeenAt, ...Object.fromEntries(unseen.map((slug) => [slug, now.toISOString()])) } };
};

export const isMuted = (prefs: Prefs, now = new Date()) => prefs.mutedUntil === 'forever' || (prefs.mutedUntil !== null && new Date(prefs.mutedUntil) > now);

export const MUTE_PERIODS: { hours: number | null; title: string }[] = [
    { hours: 1, title: 'На 1 час' },
    { hours: 2, title: 'На 2 часа' },
    { hours: 4, title: 'На 4 часа' },
    { hours: 8, title: 'На 8 часов' },
    { hours: 12, title: 'На 12 часов' },
    { hours: 24, title: 'На 24 часа' },
    { hours: null, title: 'Пока не включу' },
];

export const muteUntil = (hours: number | null, now = new Date()) => (hours === null ? 'forever' : new Date(now.getTime() + hours * 3_600_000).toISOString());
