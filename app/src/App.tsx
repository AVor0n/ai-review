import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText, type Schemas } from './api/client';
import type { ChangeEvent } from './api/events';
import { notify, reviewNotice } from './notify';
import { isWindows, serviceHint, useService } from './service';
import { applyTray, trayState } from './tray';

type Config = { intervalMinutes?: number; agents?: Record<string, { shortName?: string }> };
type StatsEntry = Parameters<typeof reviewNotice>[0];

// Сервис молчит дольше минуты — сообщаем уведомлением: поповер в это время обычно закрыт
const DOWN_NOTICE_MS = 60_000;

export const App = () => {
    const [status, setStatus] = useState<Schemas['Status'] | null>(null);
    const [config, setConfig] = useState<Config>({});
    const seenStatsAt = useRef(new Date().toISOString());
    const connectionRef = useRef<ReturnType<typeof useService> | null>(null);

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

    const connection = useService(onChange);
    connectionRef.current = connection;

    useEffect(() => {
        applyTray(trayState(status, connection.phase === 'down', config.intervalMinutes ?? 15));
    }, [status, connection.phase, config.intervalMinutes]);

    useEffect(() => {
        if (connection.phase !== 'down') return;
        const timer = setTimeout(() => notify('PR Reviewer: сервис не отвечает', serviceHint()), Math.max(0, connection.since + DOWN_NOTICE_MS - Date.now()));
        return () => clearTimeout(timer);
    }, [connection]);

    // Меню по правому клику: Rust передаёт выбранный пункт, действие выполняет API
    useEffect(() => {
        const unlisten = listen<string>('menu', async ({ payload }) => {
            const current = connectionRef.current;
            if (current?.phase !== 'up') return notify('PR Reviewer: сервис не запущен', serviceHint());
            const { api } = current;
            const result =
                payload === 'run-now' ? await api.POST('/run-now') : payload === 'stop' ? await api.POST('/stop') : payload === 'toggle-pause' ? await (status?.paused ? api.POST('/resume') : api.POST('/pause')) : null;
            if (result?.error) notify('PR Reviewer', errorText(result.error));
        });
        return () => {
            unlisten.then((stop) => stop());
        };
    }, [status?.paused]);

    return (
        <main className={`popover ${isWindows() ? 'windows' : 'mac'}`}>
            <header className="popover-header">
                <h1>PR Reviewer</h1>
                {connection.phase === 'up' && <span className="version">{connection.health.commit ?? connection.health.version}</span>}
            </header>
            {connection.phase === 'down' && (
                <section className="banner banner-error" role="alert">
                    <strong>Сервис не запущен</strong>
                    <p>{connection.reason}</p>
                    <p>{serviceHint()}</p>
                </section>
            )}
            {connection.phase === 'connecting' && <p className="placeholder">Подключение к сервису…</p>}
            {connection.phase === 'up' && <p className="placeholder">{trayState(status, false, config.intervalMinutes ?? 15).line}</p>}
        </main>
    );
};
