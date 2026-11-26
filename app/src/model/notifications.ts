import { t } from '../i18n';
import { moment } from './format';

// Настройки уведомлений по видам и репозиториям — перенос NotificationKind, NotificationRules и NotificationSettings из menubar/Alerts.swift.
// Личные, как тема: живут в localStorage вебвью, а не в config.json сервиса
export type NotificationKind = 'findings' | 'comments' | 'reviews' | 'updates' | 'fixes' | 'errors';
export type Level = 'P1' | 'P2' | 'P3';
export type NotificationRules = { enabled: NotificationKind[]; level: Level };
export type NotificationSettings = { all: NotificationRules; repos: Record<string, NotificationRules> };

// Подписи — геттеры: список общий для модуля, а текст берётся на языке момента отрисовки
const kindEntry = (id: NotificationKind, icon: string, color: string) => ({
    id,
    icon,
    color,
    get title() {
        return t(`alerts.settings.kinds.${id}.title`);
    },
    get detail() {
        return t(`alerts.settings.kinds.${id}.detail`);
    },
});

export const KINDS: { id: NotificationKind; title: string; detail: string; icon: string; color: string }[] = [
    kindEntry('findings', 'i-bubble-warning-fill', 'var(--red)'),
    kindEntry('comments', 'i-bubble-text-fill', 'var(--blue)'),
    kindEntry('reviews', 'i-bubble-check-fill', 'var(--green)'),
    kindEntry('updates', 'i-pull-request', 'var(--purple)'),
    kindEntry('fixes', 'i-fix', 'var(--orange)'),
    kindEntry('errors', 'i-warning-fill', 'var(--gray)'),
];

// Ошибки сервиса не относятся к репозиторию — настраиваются только для всех
export const REPO_KINDS = KINDS.filter((kind) => kind.id !== 'errors');

export const LEVELS: { id: Level; title: string }[] = [
    { id: 'P1', title: 'P0–P1' },
    { id: 'P2', title: 'P0–P2' },
    {
        id: 'P3',
        get title() {
            return t('alerts.settings.levelAll');
        },
    },
];

// Раньше приложение сообщало только о P0–P1, доработке и ошибках; комментарии людей — новое и полезное по умолчанию
export const DEFAULT_RULES: NotificationRules = { enabled: ['findings', 'comments', 'fixes', 'errors'], level: 'P1' };

const KEY = 'pr-reviewer.notifications';

export const loadNotifications = (): NotificationSettings => {
    try {
        const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null');
        if (stored?.all) return { all: stored.all, repos: stored.repos ?? {} };
    } catch {
        // Повреждённые настройки — как по умолчанию
    }
    return { all: DEFAULT_RULES, repos: {} };
};

export const saveNotifications = (settings: NotificationSettings) => {
    try {
        localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
        // Без хранилища настройки живут до перезапуска
    }
};

export const rulesFor = (settings: NotificationSettings, repo: string) => settings.repos[repo] ?? settings.all;

export const allows = (settings: NotificationSettings, kind: NotificationKind, repo?: string | null) =>
    (repo && kind !== 'errors' ? rulesFor(settings, repo) : settings.all).enabled.includes(kind);

// Самый низкий уровень замечаний, о котором сообщать: P1 — только P0 и P1
export const allowsLevel = (rules: NotificationRules, level: string) => level <= rules.level;

export const toggleKind = (rules: NotificationRules, kind: NotificationKind, on: boolean): NotificationRules => ({
    ...rules,
    enabled: on ? [...new Set([...rules.enabled, kind])] : rules.enabled.filter((item) => item !== kind),
});

export const repoSummary = (settings: NotificationSettings, repo: string) => {
    const own = settings.repos[repo];
    if (!own) return t('alerts.settings.repoInherit');
    return t('alerts.settings.repoOwn', { count: REPO_KINDS.filter((item) => own.enabled.includes(item.id)).length, total: REPO_KINDS.length });
};

// «Выключены до 14:30»; не сегодня — с датой; бессрочно — просто «Выключены»
export const muteSummary = (mutedUntil: string | null, now = new Date()) => {
    if (!mutedUntil || mutedUntil === 'forever') return t('alerts.settings.muted');
    return t('alerts.settings.mutedUntil', { time: moment(new Date(mutedUntil), now) });
};

const FINDING_LEVELS = ['P0', 'P1', 'P2', 'P3'];

// «P1 P2×2» — уровни по порядку, число только у повторов
export const levelsText = (counts: Record<string, number>) =>
    FINDING_LEVELS.filter((level) => (counts[level] ?? 0) > 0)
        .map((level) => (counts[level] > 1 ? `${level}×${counts[level]}` : level))
        .join(' ');
