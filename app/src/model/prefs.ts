// Личные настройки приложения — как UserDefaults в SwiftUI: свёрнутые репозитории, закрытые баннеры,
// просмотренная память, пауза уведомлений. Живут в localStorage вебвью, а не в config.json сервиса
import { t } from '../i18n';

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

const mutePeriod = (hours: number | null) => ({
    hours,
    // Подпись — геттером: список читают и меню трея, и лист уведомлений, а язык меняется на ходу
    get title() {
        return hours === null ? t('overview.mute.forever') : t('overview.mute.hours', { count: hours });
    },
});

export const MUTE_PERIODS: { hours: number | null; readonly title: string }[] = [1, 2, 4, 8, 12, 24, null].map(mutePeriod);

export const muteUntil = (hours: number | null, now = new Date()) => (hours === null ? 'forever' : new Date(now.getTime() + hours * 3_600_000).toISOString());
