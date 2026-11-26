// Журнал вызовов для проверки qa: что приложение просило у Tauri и у API
const w = window;
w.__qa ??= { invokes: [], asks: [], opened: [], notifications: [], requests: [], askAnswer: true, listeners: {}, blockSync: true };
export const qa = w.__qa;
if (!w.__qaFetch) {
    const original = w.fetch.bind(w);
    w.__qaFetch = true;
    w.fetch = async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        let body = null;
        try { body = await request.clone().text(); } catch {}
        if (!url.pathname.startsWith('/events') && !(request.method === 'GET')) qa.requests.push({ method: request.method, path: url.pathname, body, at: new Date().toISOString() });
        if (qa.failPath && qa.failPath.test(url.pathname)) return new Response(JSON.stringify({ error: 'qa: команда не выполнилась' }), { status: 409, headers: { 'content-type': 'application/json' } });
        if (qa.blockSync && request.method === 'POST' && url.pathname === '/sync') return new Response(JSON.stringify({ ok: true, output: 'qa: sync перехвачен' }), { status: 200, headers: { 'content-type': 'application/json' } });
        return original(request);
    };
}
