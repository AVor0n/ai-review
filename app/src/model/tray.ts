// Значок в трее, подсказка и меню по правому клику — как refreshIcon и rebuildMenu в menubar/main.swift,
// плюс состояние «сервис не отвечает» из спецификации 2026-11-25-tauri-popover.md
import { agentName, isPaused, isRunning, nextPassAt, reviewsOf, unreviewedPrs, waitingImportant, workerStall } from './derive';
import { moment, roleName, shortRepoName } from './format';
import { isMuted, MUTE_PERIODS, type Prefs } from './prefs';
import type { Data, Review } from './types';

export type TrayGlyph = { kind: 'icon'; id: string } | { kind: 'mark'; agent: string };

export type TrayIcon = {
    glyph: TrayGlyph;
    // template — красит система (Mac) или цвет панели задач (Windows); red и orange — цвета токенов
    color: 'template' | 'red' | 'orange';
    spin: boolean;
    blink: boolean;
    count: number;
};

export type MenuEntry = { kind: 'item'; id?: string; text: string; enabled: boolean } | { kind: 'separator' } | { kind: 'submenu'; text: string; items: MenuEntry[] };

export type TrayModel = { icon: TrayIcon; tooltip: string; menu: MenuEntry[] };

const target = (data: Data, review: Review) => `${shortRepoName(review.repo, data.config.displayPrefix)} #${review.pr} · ${agentName(data.config, review.agent)} (${roleName(review.role)})`;

// «Выключены до 14:30»; бессрочно — просто «Выключены»
export const muteSummary = (prefs: Prefs, now = new Date()) => (prefs.mutedUntil === 'forever' || !prefs.mutedUntil ? 'Выключены' : `Выключены до ${moment(new Date(prefs.mutedUntil), now)}`);

const notificationItems = (prefs: Prefs, now: Date): MenuEntry[] => {
    const muted = isMuted(prefs, now);
    const periods: MenuEntry[] = MUTE_PERIODS.map((period) => ({ kind: 'item', id: `mute:${period.hours ?? 'forever'}`, text: period.title, enabled: true }));
    return [
        ...(muted
            ? ([
                  { kind: 'item', text: `Уведомления: ${muteSummary(prefs, now).toLowerCase()}`, enabled: false },
                  { kind: 'item', id: 'unmute', text: 'Включить уведомления', enabled: true },
              ] as MenuEntry[])
            : []),
        { kind: 'submenu', text: muted ? 'Выключить на другое время' : 'Выключить уведомления', items: periods },
    ];
};

const quit: MenuEntry = { kind: 'item', id: 'quit', text: 'Выйти из PR Reviewer', enabled: true };

// Порядок проверок — как у подсказки значка
const statusLine = (data: Data, now: Date) => {
    const stall = workerStall(data.status, now);
    if (stall) return `Проход не продвигается ${stall.minutes} мин`;
    const first = reviewsOf(data.status)[0];
    if (isRunning(data.status)) return first ? `Идёт ревью: ${target(data, first)}` : 'Идёт проверка PR';
    if (data.status?.workers.fix) return 'Идёт доработка · Claude';
    if (isPaused(data.status)) return 'Фоновое ревью выключено';
    if (data.status?.phase === 'error') return 'Последний проход завершился с ошибкой';
    const next = nextPassAt(data, now);
    if (!data.status?.lastPassAt || !next) return 'Ожидание';
    const minutes = Math.ceil((next.getTime() - now.getTime()) / 60_000);
    return minutes <= 1 ? 'Следующий проход в течение минуты' : `Следующий проход через ${minutes} мин`;
};

export const trayModel = (data: Data | null, prefs: Prefs, now = new Date()): TrayModel => {
    const muted = isMuted(prefs, now);
    const muteLine = muted ? `\nУведомления: ${muteSummary(prefs, now).toLowerCase()}` : '';
    if (!data?.status)
        return {
            icon: { glyph: { kind: 'icon', id: 'i-tray-offline' }, color: 'template', spin: false, blink: false, count: 0 },
            tooltip: `PR Reviewer: сервис не отвечает${muteLine}`,
            // Пункты ревью скрыты: без сервиса они ничего не сделают
            menu: [{ kind: 'item', text: 'Сервис не отвечает', enabled: false }, { kind: 'separator' }, ...notificationItems(prefs, now), { kind: 'separator' }, quit],
        };

    const { status } = data;
    const stall = workerStall(status, now);
    const reviews = isRunning(status) && !stall ? reviewsOf(status) : [];
    const count = unreviewedPrs(data);
    let icon: TrayIcon;
    let tooltip: string;
    if (stall) {
        // Зависший проход важнее крутящегося значка модели: иначе выглядит, будто ревью идёт
        icon = { glyph: { kind: 'icon', id: 'i-tray-stall' }, color: 'orange', spin: false, blink: true, count };
        tooltip = `PR Reviewer: проход ревью не продвигается ${stall.minutes} мин — прервать можно в обзоре`;
    } else if (reviews.length) {
        // Крутится значок ревью, начавшегося раньше всех: running упорядочен по времени начала
        icon = { glyph: { kind: 'mark', agent: reviews[0].agent }, color: 'template', spin: true, blink: false, count };
        tooltip = reviews.length > 1 ? [`PR Reviewer: идут ${reviews.length} ревью`, ...reviews.map((review) => target(data, review))].join('\n') : `PR Reviewer: ревью ${target(data, reviews[0])}`;
    } else if (status.workers.fix) {
        icon = { glyph: { kind: 'mark', agent: 'claude' }, color: 'template', spin: true, blink: false, count };
        tooltip = 'PR Reviewer: доработка PR по замечаниям · Claude';
    } else if (isPaused(status)) {
        icon = { glyph: { kind: 'icon', id: 'i-tray-paused' }, color: 'template', spin: false, blink: false, count };
        tooltip = 'PR Reviewer: пауза';
    } else if (isRunning(status)) {
        icon = { glyph: { kind: 'icon', id: 'i-tray-checking' }, color: 'template', spin: false, blink: false, count };
        tooltip = 'PR Reviewer: идёт проверка PR';
    } else if (status.phase === 'error') {
        icon = { glyph: { kind: 'icon', id: 'i-tray-error' }, color: 'red', spin: false, blink: false, count };
        tooltip = 'PR Reviewer: ошибка';
    } else {
        icon = { glyph: { kind: 'icon', id: 'i-tray-idle' }, color: 'template', spin: false, blink: false, count };
        tooltip = 'PR Reviewer: ожидание';
    }
    if (count > 0) tooltip += `\nPR без ревью на текущем коммите: ${count}`;
    const important = waitingImportant(data);
    if (important > 0) tooltip += `\nВажных замечаний ждут правки: ${important}`;
    tooltip += muteLine;

    const head: MenuEntry[] =
        reviews.length > 1
            ? [
                  { kind: 'item', text: `Идут ${reviews.length} ревью:`, enabled: false },
                  ...reviews.map((review): MenuEntry => ({ kind: 'item', text: target(data, review), enabled: false })),
                  ...(status.workers.fix ? [{ kind: 'item', text: 'Идёт доработка · Claude', enabled: false } as MenuEntry] : []),
              ]
            : [{ kind: 'item', text: statusLine(data, now), enabled: false }];
    // Как кнопки ■ и ▶ в шапке обзора: явное ревью по иконке идёт и при выключенном фоновом, его тоже можно прервать
    const actions: MenuEntry[] = isRunning(status)
        ? [{ kind: 'item', id: 'stop', text: reviews.length > 1 ? 'Прервать все ревью' : 'Прервать ревью', enabled: true }]
        : isPaused(status)
          ? []
          : [{ kind: 'item', id: 'run-now', text: 'Проверить сейчас', enabled: true }];
    actions.push({ kind: 'item', id: 'toggle-pause', text: isPaused(status) ? 'Включить фоновое ревью' : 'Выключить фоновое ревью', enabled: true });
    return { icon, tooltip, menu: [...head, { kind: 'separator' }, ...actions, { kind: 'separator' }, ...notificationItems(prefs, now), { kind: 'separator' }, quit] };
};
