import { t } from '../i18n';

// Поток изменений GET /events (SSE). EventSource не умеет заголовок Authorization, поэтому поток читается через fetch
export type ChangeEvent = { type: string; at: string };

// Разбор кадров SSE: возвращает события и недочитанный хвост
export const parseFrames = (buffer: string): { events: { event: string; data: string }[]; rest: string } => {
    const frames = buffer.split(/\r?\n\r?\n/);
    const rest = frames.pop() ?? '';
    const events = frames.flatMap((frame) => {
        let event = 'message';
        const data: string[] = [];
        for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        return data.length ? [{ event, data: data.join('\n') }] : [];
    });
    return { events, rest };
};

// Читает поток, пока соединение живо; промис завершается, когда сервер закрыл поток или он оборвался
export const streamEvents = async (url: string, token: string, onChange: (event: ChangeEvent) => void, signal: AbortSignal) => {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
    if (!response.ok || !response.body) throw new Error(t('app.service.streamStatus', { status: response.status }));
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        const parsed = parseFrames(buffer + value);
        buffer = parsed.rest;
        for (const { event, data } of parsed.events) if (event === 'change') onChange(JSON.parse(data) as ChangeEvent);
    }
};
