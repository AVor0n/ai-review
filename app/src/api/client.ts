import createClient, { type Middleware } from 'openapi-fetch';
import { t } from '../i18n';
import type { components, paths } from './schema';

// Клиент и типы — из schema/api.openapi.json (npm run gen:api). Руками маршруты и ответы не описываем
export type Schemas = components['schemas'];
export type ApiClient = ReturnType<typeof createApi>;

export const DEFAULT_PORT = 8765;
export const baseUrl = (port = DEFAULT_PORT) => `http://127.0.0.1:${port}`;

export const createApi = (token: string, port = DEFAULT_PORT) => {
    const client = createClient<paths>({ baseUrl: baseUrl(port) });
    const auth: Middleware = {
        onRequest({ request }) {
            request.headers.set('Authorization', `Bearer ${token}`);
            return request;
        },
    };
    client.use(auth);
    return client;
};

// Ошибка API — понятный текст по-русски в поле error
export const errorText = (error: unknown, fallback = t('app.service.noAnswer')) =>
    error && typeof error === 'object' && 'error' in error && typeof error.error === 'string' ? error.error : fallback;
