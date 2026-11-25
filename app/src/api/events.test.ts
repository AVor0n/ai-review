import { describe, expect, it } from 'vitest';
import { parseFrames } from './events';

describe('parseFrames', () => {
    it('разбирает события, пропускает пинги и оставляет недочитанный хвост', () => {
        const { events, rest } = parseFrames('event: hello\ndata: {"at":"1"}\n\n: ping\n\nevent: change\ndata: {"type":"status"}\n\nevent: change\ndata: {"ty');
        expect(events).toEqual([
            { event: 'hello', data: '{"at":"1"}' },
            { event: 'change', data: '{"type":"status"}' },
        ]);
        expect(rest).toBe('event: change\ndata: {"ty');
    });

    it('кадр, разорванный между кусками потока, собирается целиком', () => {
        const first = parseFrames('event: change\ndata: {"type":"li');
        const second = parseFrames(`${first.rest}mits"}\n\n`);
        expect(first.events).toEqual([]);
        expect(second.events).toEqual([{ event: 'change', data: '{"type":"limits"}' }]);
    });
});
