// Значок в трее, подсказка и меню по правому клику — как refreshIcon и rebuildMenu в menubar/main.swift,
// плюс состояние «сервис не отвечает» из спецификации 2026-11-25-tauri-popover.md
import { agentName, isPaused, isRunning, nextPassAt, reviewsOf, unreviewedPrs, waitingImportant, workerStall } from './derive';
import { moment, roleName, shortRepoName } from './format';
import { t } from '../i18n';
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

// «Уведомления: выключены до 14:30»; бессрочно — просто «выключены»
const muteLine = (prefs: Prefs, now: Date) =>
    prefs.mutedUntil === 'forever' || !prefs.mutedUntil ? t('tray.mute.line') : t('tray.mute.lineUntil', { time: moment(new Date(prefs.mutedUntil), now) });

const notificationItems = (prefs: Prefs, now: Date): MenuEntry[] => {
    const muted = isMuted(prefs, now);
    const periods: MenuEntry[] = MUTE_PERIODS.map((period) => ({ kind: 'item', id: `mute:${period.hours ?? 'forever'}`, text: period.title, enabled: true }));
    return [
        ...(muted
            ? ([
                  { kind: 'item', text: muteLine(prefs, now), enabled: false },
                  { kind: 'item', id: 'unmute', text: t('tray.mute.unmute'), enabled: true },
              ] as MenuEntry[])
            : []),
        { kind: 'submenu', text: muted ? t('tray.mute.muteOther') : t('tray.mute.mute'), items: periods },
    ];
};

const quit = (): MenuEntry => ({ kind: 'item', id: 'quit', text: t('tray.menu.quit'), enabled: true });

// Порядок проверок — как у подсказки значка
const statusLine = (data: Data, now: Date) => {
    const stall = workerStall(data.status, now);
    if (stall) return t('tray.status.stall', { minutes: stall.minutes });
    const first = reviewsOf(data.status)[0];
    if (isRunning(data.status)) return first ? t('tray.status.reviewing', { target: target(data, first) }) : t('tray.status.checking');
    if (data.status?.workers.fix) return t('tray.status.fixing');
    if (isPaused(data.status)) return t('tray.status.paused');
    if (data.status?.phase === 'error') return t('tray.status.error');
    const next = nextPassAt(data, now);
    if (!data.status?.lastPassAt || !next) return t('tray.status.idle');
    const minutes = Math.ceil((next.getTime() - now.getTime()) / 60_000);
    return minutes <= 1 ? t('tray.status.soon') : t('tray.status.next', { minutes });
};

export const trayModel = (data: Data | null, prefs: Prefs, now = new Date()): TrayModel => {
    const muted = isMuted(prefs, now);
    const muteSuffix = muted ? `\n${muteLine(prefs, now)}` : '';
    if (!data?.status)
        return {
            icon: { glyph: { kind: 'icon', id: 'i-tray-offline' }, color: 'template', spin: false, blink: false, count: 0 },
            tooltip: `${t('tray.tooltip.offline')}${muteSuffix}`,
            // Пункты ревью скрыты: без сервиса они ничего не сделают
            menu: [{ kind: 'item', text: t('tray.menu.offline'), enabled: false }, { kind: 'separator' }, ...notificationItems(prefs, now), { kind: 'separator' }, quit()],
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
        tooltip = t('tray.tooltip.stall', { minutes: stall.minutes });
    } else if (reviews.length) {
        // Крутится значок ревью, начавшегося раньше всех: running упорядочен по времени начала
        icon = { glyph: { kind: 'mark', agent: reviews[0].agent }, color: 'template', spin: true, blink: false, count };
        tooltip =
            reviews.length > 1
                ? [t('tray.tooltip.reviews', { count: reviews.length }), ...reviews.map((review) => target(data, review))].join('\n')
                : t('tray.tooltip.review', { target: target(data, reviews[0]) });
    } else if (status.workers.fix) {
        icon = { glyph: { kind: 'mark', agent: 'claude' }, color: 'template', spin: true, blink: false, count };
        tooltip = t('tray.tooltip.fixing');
    } else if (isPaused(status)) {
        icon = { glyph: { kind: 'icon', id: 'i-tray-paused' }, color: 'template', spin: false, blink: false, count };
        tooltip = t('tray.tooltip.paused');
    } else if (isRunning(status)) {
        icon = { glyph: { kind: 'icon', id: 'i-tray-checking' }, color: 'template', spin: false, blink: false, count };
        tooltip = t('tray.tooltip.checking');
    } else if (status.phase === 'error') {
        icon = { glyph: { kind: 'icon', id: 'i-tray-error' }, color: 'red', spin: false, blink: false, count };
        tooltip = t('tray.tooltip.error');
    } else {
        icon = { glyph: { kind: 'icon', id: 'i-tray-idle' }, color: 'template', spin: false, blink: false, count };
        tooltip = t('tray.tooltip.idle');
    }
    if (count > 0) tooltip += `\n${t('tray.tooltip.unreviewed', { count })}`;
    const important = waitingImportant(data);
    if (important > 0) tooltip += `\n${t('tray.tooltip.important', { count: important })}`;
    tooltip += muteSuffix;

    const head: MenuEntry[] =
        reviews.length > 1
            ? [
                  { kind: 'item', text: t('tray.menu.reviews', { count: reviews.length }), enabled: false },
                  ...reviews.map((review): MenuEntry => ({ kind: 'item', text: target(data, review), enabled: false })),
                  ...(status.workers.fix ? [{ kind: 'item', text: t('tray.status.fixing'), enabled: false } as MenuEntry] : []),
              ]
            : [{ kind: 'item', text: statusLine(data, now), enabled: false }];
    // Как кнопки ■ и ▶ в шапке обзора: явное ревью по иконке идёт и при выключенном фоновом, его тоже можно прервать
    const actions: MenuEntry[] = isRunning(status)
        ? [{ kind: 'item', id: 'stop', text: reviews.length > 1 ? t('tray.menu.stopAll') : t('tray.menu.stop'), enabled: true }]
        : isPaused(status)
          ? []
          : [{ kind: 'item', id: 'run-now', text: t('tray.menu.runNow'), enabled: true }];
    actions.push({ kind: 'item', id: 'toggle-pause', text: isPaused(status) ? t('tray.menu.resume') : t('tray.menu.pause'), enabled: true });
    return { icon, tooltip, menu: [...head, { kind: 'separator' }, ...actions, { kind: 'separator' }, ...notificationItems(prefs, now), { kind: 'separator' }, quit()] };
};
