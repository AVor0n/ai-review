import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
import { baseUrl, createApi, type ApiClient, type Schemas } from './api/client';
import { streamEvents, type ChangeEvent } from './api/events';

// Связь с сервисом: токен → /health → поток /events. Пока сервис отвечает, API по таймеру не опрашиваем:
// после события перечитываем нужный ресурс. Если сервис недоступен — повторяем подключение с паузой
export type Connection =
    | { phase: 'connecting' }
    | { phase: 'down'; reason: string; since: number }
    | { phase: 'up'; api: ApiClient; health: Schemas['Health'] };

type Listener = (event: ChangeEvent) => void;

const RETRY_MS = [2_000, 5_000, 10_000, 30_000];

export const useService = (onChange: Listener) => {
    const [connection, setConnection] = useState<Connection>({ phase: 'connecting' });
    const listener = useRef(onChange);
    listener.current = onChange;

    useEffect(() => {
        const controller = new AbortController();
        let attempt = 0;
        let downSince: number | null = null;
        const down = (reason: string) => {
            downSince ??= Date.now();
            setConnection({ phase: 'down', reason, since: downSince });
        };
        const loop = async () => {
            while (!controller.signal.aborted) {
                try {
                    const token = await invoke<string>('api_token');
                    const api = createApi(token);
                    const { data: health } = await api.GET('/health', { signal: controller.signal });
                    if (!health) throw new Error('Сервис не ответил');
                    attempt = 0;
                    downSince = null;
                    setConnection({ phase: 'up', api, health });
                    listener.current({ type: 'connected', at: new Date().toISOString() });
                    await streamEvents(`${baseUrl()}/events`, token, (event) => listener.current(event), controller.signal);
                    down('Поток событий оборвался');
                } catch (error) {
                    if (controller.signal.aborted) return;
                    // invoke отдаёт строку с причиной, fetch — TypeError «Failed to fetch» при закрытом порте
                    down(typeof error === 'string' ? error : 'Сервис не отвечает на 127.0.0.1');
                }
                await new Promise((resolve) => setTimeout(resolve, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]));
            }
        };
        loop();
        return () => controller.abort();
    }, []);

    return connection;
};

export const isWindows = () => navigator.userAgent.includes('Windows');

export const serviceHint = () =>
    isWindows()
        ? 'Откройте Ubuntu (WSL) и выполните systemctl --user start pr-reviewer-api. Если сервис не установлен — ./install.sh в папке PR Reviewer внутри WSL.'
        : 'Запустите ./install.sh в папке PR Reviewer: он поставит и запустит сервис и его API.';
