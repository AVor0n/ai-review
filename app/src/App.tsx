import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText, type Schemas } from './api/client';
import type { ChangeEvent } from './api/events';
import { notify, reviewNotice } from './notify';
import icons from '../../product/design/web/icons.svg?url';
import { isWindows, serviceDown, useService, type Connection } from './service';
import { applyTray, trayState } from './tray';

type Config = { intervalMinutes?: number; agents?: Record<string, { shortName?: string }> };
type StatsEntry = Parameters<typeof reviewNotice>[0];

// Сервис молчит дольше минуты — сообщаем уведомлением: поповер в это время обычно закрыт
const DOWN_NOTICE_MS = 60_000;

export const App = () => {
    const [status, setStatus] = useState<Schemas['Status'] | null>(null);
    const [config, setConfig] = useState<Config>({});
    const seenStatsAt = useRef(new Date().toISOString());
    const connectionRef = useRef<Connection | null>(null);

    const onChange = useCallback(async (event: ChangeEvent) => {
        const connection = connectionRef.current;
        if (connection?.phase !== 'up') return;
        const { api } = connection;
        if (event.type === 'connected' || event.type === 'status') setStatus((await api.GET('/status')).data ?? null);
        if (event.type === 'connected' || event.type === 'config') setConfig(((await api.GET('/config')).data as Config) ?? {});
        if (event.type === 'stats') {
            // since включает границу: запись с тем же временем уже показана
            const since = seenStatsAt.current;
            const { data } = await api.GET('/stats', { params: { query: { since } } });
            const entries = ((data ?? []) as StatsEntry[]).filter((entry) => entry.at > since);
            if (entries.length) seenStatsAt.current = entries[entries.length - 1].at;
            for (const entry of entries.filter((item) => item.pass !== 'replies')) {
                const notice = reviewNotice(entry, (id) => config.agents?.[id]?.shortName ?? id);
                notify(notice.title, notice.body);
            }
        }
    }, [config]);

    const { connection, retry } = useService(onChange);
    connectionRef.current = connection;

    useEffect(() => {
        applyTray(trayState(status, connection.phase === 'down', config.intervalMinutes ?? 15));
    }, [status, connection.phase, config.intervalMinutes]);

    useEffect(() => {
        if (connection.phase !== 'down') return;
        const timer = setTimeout(() => notify('PR Reviewer: сервис не отвечает', serviceDown().text), Math.max(0, connection.since + DOWN_NOTICE_MS - Date.now()));
        return () => clearTimeout(timer);
    }, [connection]);

    // Rust ставит окно у значка и передаёт, где центр стрелки
    useEffect(() => {
        const unlisten = listen<{ arrowX: number }>('popover-shown', ({ payload }) => document.documentElement.style.setProperty('--arrow-x', `${payload.arrowX}px`));
        return () => {
            unlisten.then((stop) => stop());
        };
    }, []);

    // Меню по правому клику: Rust передаёт выбранный пункт, действие выполняет API
    useEffect(() => {
        const unlisten = listen<string>('menu', async ({ payload }) => {
            const current = connectionRef.current;
            if (current?.phase !== 'up') return notify('PR Reviewer: сервис не запущен', serviceDown().text);
            const { api } = current;
            const result =
                payload === 'run-now' ? await api.POST('/run-now') : payload === 'stop' ? await api.POST('/stop') : payload === 'toggle-pause' ? await (status?.paused ? api.POST('/resume') : api.POST('/pause')) : null;
            if (result?.error) notify('PR Reviewer', errorText(result.error));
        });
        return () => {
            unlisten.then((stop) => stop());
        };
    }, [status?.paused]);

    // Рамка — классы дизайн-системы (product/design/web/components.css): на Mac стрелка к значку, на Windows без неё
    const platform = isWindows() ? 'win' : 'mac';
    return (
        <div className={`window-frame window-frame--${platform}`}>
            <div className={`popover-frame popover-frame--${platform}`}>
                {platform === 'mac' && (
                    <svg className="popover__arrow" viewBox="0 0 24 11" aria-hidden="true">
                        <path d="M0 11C5 11 8.5 1 12 1S19 11 24 11Z" fill="currentColor" />
                    </svg>
                )}
                <main className="popover">
                    <div className="popover__body">
                        {connection.phase === 'down' && (
                            <div className="banners">
                                <div className="banner banner--critical" role="alert" title={connection.reason}>
                                    <svg className="icon banner__icon" aria-hidden="true">
                                        <use href={`${icons}#i-power`} />
                                    </svg>
                                    <div className="banner__body">
                                        <div className="banner__title">Сервис не запущен</div>
                                        <div className="banner__text">{serviceDown().text}</div>
                                        <div className="banner__command selectable">{serviceDown().command}</div>
                                    </div>
                                    <div className="banner__actions">
                                        <button className="link-button" onClick={() => navigator.clipboard.writeText(serviceDown().command)}>
                                            Скопировать команду
                                        </button>
                                        <button className="link-button" onClick={retry}>
                                            Проверить снова
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                        {connection.phase === 'down' && (
                            <div className="empty-state">
                                <svg className="icon empty-state__icon" aria-hidden="true">
                                    <use href={`${icons}#i-tray`} />
                                </svg>
                                <div className="empty-state__title">Нет данных</div>
                                <div className="empty-state__text">Список PR появится, когда сервис ответит</div>
                            </div>
                        )}
                        {connection.phase === 'connecting' && <p className="placeholder">Подключение к сервису…</p>}
                        {connection.phase === 'up' && <p className="placeholder">{trayState(status, false, config.intervalMinutes ?? 15).line}</p>}
                    </div>
                </main>
            </div>
        </div>
    );
};
