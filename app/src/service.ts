import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
import { baseUrl, createApi, type ApiClient, type Schemas } from './api/client';
import { streamEvents, type ChangeEvent } from './api/events';
import { t } from './i18n';

// Связь с сервисом: токен → /health → поток /events. Пока сервис отвечает, API по таймеру не опрашиваем:
// после события перечитываем нужный ресурс. Если сервис недоступен — повторяем подключение с паузой
export type Connection =
    | { phase: 'connecting' }
    | { phase: 'down'; reason: string; since: number }
    | { phase: 'up'; api: ApiClient; health: Schemas['Health'] };

// Клиент API — вместе с событием: состояние React с ним обновится позже, чем придёт первое событие
type Listener = (event: ChangeEvent, api: ApiClient) => void;

const RETRY_MS = [2_500, 2_500, 5_000, 10_000, 30_000];
// Баннер — только после второй неудачи подряд (около 5 с): при запуске сервиса он не мигает
const FAILURES_BEFORE_BANNER = 2;

export const useService = (onChange: Listener) => {
    const [connection, setConnection] = useState<Connection>({ phase: 'connecting' });
    const listener = useRef(onChange);
    listener.current = onChange;
    const retryNow = useRef<() => void>(() => {});

    useEffect(() => {
        const controller = new AbortController();
        let attempt = 0;
        let failures = 0;
        let downSince: number | null = null;
        const down = (reason: string) => {
            downSince ??= Date.now();
            if (++failures >= FAILURES_BEFORE_BANNER) setConnection({ phase: 'down', reason, since: downSince });
        };
        const loop = async () => {
            while (!controller.signal.aborted) {
                try {
                    const token = await invoke<string>('api_token');
                    const api = createApi(token);
                    const { data: health } = await api.GET('/health', { signal: controller.signal });
                    if (!health) throw new Error(t('app.service.noAnswer'));
                    attempt = 0;
                    failures = 0;
                    downSince = null;
                    setConnection({ phase: 'up', api, health });
                    listener.current({ type: 'connected', at: new Date().toISOString() }, api);
                    await streamEvents(`${baseUrl()}/events`, token, (event) => listener.current(event, api), controller.signal);
                    down(t('app.service.streamBroken'));
                } catch (error) {
                    if (controller.signal.aborted) return;
                    // invoke отдаёт строку с причиной, fetch — TypeError «Failed to fetch» при закрытом порте
                    down(typeof error === 'string' ? error : t('app.service.unreachable'));
                }
                // «Проверить снова» прерывает паузу и пробует сразу
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
                    retryNow.current = () => {
                        clearTimeout(timer);
                        resolve();
                    };
                });
            }
        };
        loop();
        return () => controller.abort();
    }, []);

    return { connection, retry: () => retryNow.current() };
};

export const isWindows = () => navigator.userAgent.includes('Windows');

// Тексты и команды — из макета (agents/design/mockups/2026-11-25-tauri-popover.html, «сервис не отвечает»)
export const serviceDown = () =>
    isWindows()
        ? {
              text: t('app.service.downWsl', { address: baseUrl().replace('http://', '') }),
              command: 'wsl systemctl --user restart pr-reviewer-api',
          }
        : {
              text: t('app.service.downMac', { address: baseUrl().replace('http://', '') }),
              command: 'launchctl kickstart -k gui/$(id -u)/com.avoronin.pr-reviewer.api',
          };
