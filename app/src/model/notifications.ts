import { moment } from './format';

// Настройки уведомлений по видам и репозиториям — перенос NotificationKind, NotificationRules и NotificationSettings из menubar/Alerts.swift.
// Личные, как тема: живут в localStorage вебвью, а не в config.json сервиса
export type NotificationKind = 'findings' | 'comments' | 'reviews' | 'updates' | 'fixes' | 'errors';
export type Level = 'P1' | 'P2' | 'P3';
export type NotificationRules = { enabled: NotificationKind[]; level: Level };
export type NotificationSettings = { all: NotificationRules; repos: Record<string, NotificationRules> };

export const KINDS: { id: NotificationKind; title: string; detail: string; icon: string; color: string }[] = [
    { id: 'findings', title: 'Замечания моделей', detail: 'Новые замечания в PR', icon: 'i-bubble-warning-fill', color: 'var(--red)' },
    { id: 'comments', title: 'Комментарии людей', detail: 'Новые треды и ответы команды, кроме ваших', icon: 'i-bubble-text-fill', color: 'var(--blue)' },
    { id: 'reviews', title: 'Ревью завершено', detail: 'Модель прошла PR: сколько замечаний или «чисто»', icon: 'i-bubble-check-fill', color: 'var(--green)' },
    { id: 'updates', title: 'Обновление PR', detail: 'Новые коммиты, новые и закрытые PR', icon: 'i-pull-request', color: 'var(--purple)' },
    { id: 'fixes', title: 'Доработка и rebase', detail: 'Итог: запушено, конфликты, упали проверки', icon: 'i-fix', color: 'var(--orange)' },
    { id: 'errors', title: 'Ошибки сервиса', detail: 'Первая ошибка подряд и зависший проход', icon: 'i-warning-fill', color: 'var(--gray)' },
];

// Ошибки сервиса не относятся к репозиторию — настраиваются только для всех
export const REPO_KINDS = KINDS.filter((kind) => kind.id !== 'errors');

export const LEVELS: { id: Level; title: string }[] = [
    { id: 'P1', title: 'P0–P1' },
    { id: 'P2', title: 'P0–P2' },
    { id: 'P3', title: 'Все' },
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
    if (!own) return 'Как для всех';
    return `Свои · ${REPO_KINDS.filter((kind) => own.enabled.includes(kind.id)).length} из ${REPO_KINDS.length}`;
};

// «Выключены до 14:30»; не сегодня — с датой; бессрочно — просто «Выключены»
export const muteSummary = (mutedUntil: string | null, now = new Date()) => {
    if (!mutedUntil || mutedUntil === 'forever') return 'Выключены';
    return `Выключены до ${moment(new Date(mutedUntil), now)}`;
};
