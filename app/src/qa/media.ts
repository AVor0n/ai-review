import type { ApiClient } from '../api/client';
import { t } from '../i18n';

// Скриншоты и видео прогона приходят через API сервиса (GET /qa/{repo}/{pr}/file): на Windows файлы лежат в WSL,
// а вебвью их напрямую не видит. Ссылки blob живут, пока открыто приложение
const files = new Map<string, Promise<string>>();
const thumbs = new Map<string, Promise<string>>();
const THUMB_SIZE = 480;

export const isVideo = (path: string) => path.toLowerCase().endsWith('.webm');
export const isMedia = (path: string) => /\.(png|webm)$/i.test(path);
export const fileName = (path: string) => path.split('/').pop() ?? path;

export const mediaUrl = (api: ApiClient, repo: string, pr: number, path: string) => {
    const key = `${repo}#${pr}#${path}`;
    if (!files.has(key)) {
        const request = api.GET('/qa/{repo}/{pr}/file', { params: { path: { repo, pr }, query: { path } }, parseAs: 'blob' }).then(({ data, error }) => {
            if (!data) throw new Error(error ? String((error as { error?: string }).error ?? error) : t('qa.media.notReceived'));
            return URL.createObjectURL(data as Blob);
        });
        request.catch(() => files.delete(key));
        files.set(key, request);
    }
    return files.get(key)!;
};

// Превью уменьшаются до 480 px: полноразмерный скриншот Playwright 1600×900 занял бы в памяти мегабайты
export const thumbUrl = (api: ApiClient, repo: string, pr: number, path: string) => {
    const key = `${repo}#${pr}#${path}`;
    if (!thumbs.has(key)) {
        const request = mediaUrl(api, repo, pr, path).then(async (url) => {
            const bitmap = await createImageBitmap(await (await fetch(url)).blob());
            const scale = Math.min(1, THUMB_SIZE / Math.max(bitmap.width, bitmap.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(bitmap.width * scale);
            canvas.height = Math.round(bitmap.height * scale);
            canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
            return blob ? URL.createObjectURL(blob) : url;
        });
        request.catch(() => thumbs.delete(key));
        thumbs.set(key, request);
    }
    return thumbs.get(key)!;
};

// Окно просмотра получает список файлов кейса в адресе страницы
export type ViewerRequest = { repo: string; pr: number; runDir: string; files: string[]; index: number };
export const viewerQuery = (request: ViewerRequest) => encodeURIComponent(JSON.stringify(request));
export const parseViewerQuery = (query: string): ViewerRequest | null => {
    try {
        return JSON.parse(decodeURIComponent(query));
    } catch {
        return null;
    }
};
