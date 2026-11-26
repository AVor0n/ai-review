import { describe, expect, it } from 'vitest';
import { banners, moreMessages } from './banners';
import { availability, canTest, headline, isTaskBranch, qaConfigured, reviewState, tokens, unreviewedPrs, workerStall } from './derive';
import { ago, plural, resetShort, shortRepoName } from './format';
import { defaultPrefs, muteUntil } from './prefs';
import { capsules, fixAction, modelHint, sortedPrs, threadsCounter } from './row';
import { trayModel, type MenuEntry } from './tray';
import { emptyData, type Data, type PullRequest, type Status } from './types';

const NOW = new Date(2026, 10, 26, 14, 0);
const texts = (menu: MenuEntry[]) => menu.flatMap((entry) => (entry.kind === 'separator' ? [] : [entry.text]));
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const status = (patch: Partial<Status> = {}): Status => ({
    phase: 'idle',
    paused: false,
    workerRunning: false,
    heartbeat: null,
    queue: [],
    workers: { fix: false, arch: false, qa: false },
    lastPassAt: minutesAgo(3),
    ...patch,
});

const pr = (patch: Partial<PullRequest> = {}): PullRequest => ({
    id: 2828,
    title: 'Экспорт заказа в PDF',
    draft: false,
    author: 'Вера Л.',
    updatedOn: minutesAgo(5),
    commentCount: 0,
    openThreads: 0,
    resolvedThreads: 0,
    url: 'https://bitbucket.org/w/frontend/pull-requests/2828',
    head: 'abc123',
    source: 'PROJ-1234-order-pdf',
    destination: 'develop',
    ...patch,
});

const data = (patch: Partial<Data> = {}): Data => ({
    ...emptyData(),
    status: status(),
    config: {
        repos: [{ workspace: 'w', slug: 'frontend' }],
        agents: { claude: { shortName: 'Claude' }, codex: { shortName: 'Codex' }, cursor: { shortName: 'Cursor', auto: false } },
        intervalMinutes: 15,
    },
    snapshots: { 'frontend': { fetchedAt: minutesAgo(2), prs: [pr()] } },
    ...patch,
});

describe('даты и числа', () => {
    it('давность — как в SwiftUI и макете', () => {
        expect(ago(minutesAgo(0.5), NOW)).toBe('только что');
        expect(ago(minutesAgo(5), NOW)).toBe('5 минут назад');
        expect(ago(minutesAgo(65), NOW)).toBe('1 час назад');
        expect(ago(minutesAgo(19 * 60), NOW)).toBe('19 часов назад');
        expect(ago(new Date(2026, 10, 25, 9, 0), NOW)).toBe('вчера');
    });

    it('сброс лимита: сегодня — время, завтра — «завтра»', () => {
        expect(resetShort(new Date(2026, 10, 26, 14, 30), NOW)).toBe('до 14:30');
        expect(resetShort(new Date(2026, 10, 27, 9, 5), NOW)).toBe('до завтра 09:05');
    });

    it('склонения', () => {
        expect(moreMessages(1)).toBe('Ещё 1 сообщение');
        expect(moreMessages(2)).toBe('Ещё 2 сообщения');
        expect(moreMessages(11)).toBe('Ещё 11 сообщений');
        expect(plural(22, 'кейс', 'кейса', 'кейсов')).toBe('кейса');
    });
});

describe('состояние моделей', () => {
    it('ревью: идёт, в очереди, актуально, на старом коммите', () => {
        const base = data({ state: { repos: { 'frontend': { prs: { '2828': { reviewed: { claude: 'abc123', codex: 'old' } } } } } } });
        expect(reviewState(base, 'frontend', pr(), 'claude')).toBe('done');
        expect(reviewState(base, 'frontend', pr(), 'codex')).toBe('stale');
        expect(reviewState(base, 'frontend', pr(), 'cursor')).toBe('none');
        const busy = { ...base, status: status({ workerRunning: true, running: [{ repo: 'frontend', pr: 2828, agent: 'claude', role: 'first' }], queue: [{ repo: 'frontend', pr: 2828, agent: 'codex' }] }) };
        expect(reviewState(busy, 'frontend', pr(), 'claude')).toBe('running');
        expect(reviewState(busy, 'frontend', pr(), 'codex')).toBe('queued');
    });

    it('лимит и «только вручную» — в капсулах шапки, лимит первым', () => {
        const limited = data({ limits: { codex: { usedPercent: 100, resetsAt: new Date(2026, 10, 26, 14, 30).toISOString(), at: minutesAgo(3) } } });
        expect(availability(limited, 'codex', NOW).kind).toBe('limit');
        expect(capsules(limited, NOW).map((capsule) => capsule.text)).toEqual(['Codex: лимит до 14:30', 'Cursor: только вручную']);
        // При выключенном фоновом ревью вручную работают все модели
        expect(capsules({ ...limited, status: status({ paused: true }) }, NOW).map((capsule) => capsule.agent)).toEqual(['codex']);
    });

    it('подсказки значка модели', () => {
        expect(modelHint('Cursor', 'done', { kind: 'manual' }, null)).toBe('Cursor: ревью актуально. Нажмите, чтобы проверить заново. В фоне эта модель не запускается');
        expect(modelHint('Claude', 'done', { kind: 'available' }, 'rebase')).toBe('Claude: повторное ревью не нужно — после rebase изменения те же. Нажмите, чтобы проверить заново');
    });
});

describe('шапка и строка PR', () => {
    it('ожидание и следующая проверка', () => {
        expect(headline(data(), NOW)).toBe('Ожидание · следующая проверка через 12 мин');
        expect(headline(data({ status: status({ paused: true }) }), NOW)).toBe('Фоновое ревью выключено');
        expect(headline(data({ status: status({ workerRunning: true, running: [{ repo: 'frontend', pr: 2828, agent: 'claude', role: 'first' }] }) }), NOW)).toBe('Идёт ревью frontend #2828 · Claude');
    });

    it('счётчик тредов: галочка — только когда все фоновые модели проверили последний коммит', () => {
        const reviewed = data({ state: { repos: { 'frontend': { prs: { '2828': { reviewed: { claude: 'abc123', codex: 'abc123' } } } } } } });
        expect(threadsCounter(reviewed, 'frontend', pr(), NOW).kind).toBe('clean');
        expect(threadsCounter(data(), 'frontend', pr({ draft: true }), NOW).hint).toBe('Черновик — фоновое ревью черновики пропускает. Запустить можно по значку модели');
        expect(threadsCounter(data(), 'frontend', pr({ openThreads: 2, resolvedThreads: 1, commentCount: 5 }), NOW)).toMatchObject({ kind: 'open', label: '1/3' });
    });

    it('доработка: Fix при открытых замечаниях, Rebase при отставании, прерванная — сбой', () => {
        expect(fixAction(data(), 'frontend', pr({ openThreads: 2 })).click).toBe('start-fix');
        const rebase = fixAction(data(), 'frontend', pr({ behind: 4, conflicts: true }));
        expect(rebase).toMatchObject({ click: 'start-rebase', icon: 'i-rebase', color: 'orange' });
        expect(fixAction(data(), 'frontend', pr()).disabled).toBe(true);
        const interrupted = data({ fixes: [{ repo: 'frontend', pr: 2828, state: 'running' }] });
        expect(fixAction(interrupted, 'frontend', pr())).toMatchObject({ icon: 'i-warning', color: 'orange', click: 'report' });
    });

    it('черновики — вниз, остальные по свежести', () => {
        const list = sortedPrs([pr({ id: 1, draft: true, updatedOn: minutesAgo(1) }), pr({ id: 2, updatedOn: minutesAgo(60) }), pr({ id: 3, updatedOn: minutesAgo(5) })]);
        expect(list.map((item) => item.id)).toEqual([3, 2, 1]);
    });

    it('PR без ревью на текущем коммите: черновики и ветки вне шаблона не считаются', () => {
        const snapshots = { 'frontend': { fetchedAt: minutesAgo(1), prs: [pr(), pr({ id: 2, draft: true }), pr({ id: 3, source: 'feature/x' })] } };
        expect(unreviewedPrs(data({ snapshots }))).toBe(1);
    });
});

describe('баннеры', () => {
    it('порядок: завис, ошибка, истёкший токен, истекающий, память', () => {
        const saved = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
        const value = data({
            status: status({ workerRunning: false, phase: 'error', lastError: 'git: timeout' }),
            config: { ...data().config, bitbucket: { keychainService: 'bb' }, agents: { claude: { shortName: 'Claude', keychainService: 'cl' } }, memory: { maxLessons: 10 } },
            secrets: [
                { id: 'bitbucket', present: true, savedAt: saved(360) },
                { id: 'claude', present: true, savedAt: saved(400) },
            ],
            memory: { 'frontend': Array.from({ length: 11 }, (_, index) => ({ id: `l${index}`, text: 'правило', at: saved(30), manual: true })) },
        });
        const list = banners(value, defaultPrefs(), { syncError: null, memoryBroken: {} }, NOW);
        expect(list.map((banner) => banner.id)).toEqual(['error', 'token-claude', 'token-bitbucket', 'memory-frontend']);
        expect(list[2]).toMatchObject({ variant: 'warning', text: 'Без него фоновое ревью не видит PR и не публикует комментарии. Выпустите новый и сохраните — срок обновится сам.' });
        expect(list[3]).toMatchObject({ variant: 'critical', title: 'Память frontend переполнена: 11 из 10' });
        expect(tokens(value, NOW).find((token) => token.id === 'bitbucket')?.daysLeft).toBe(5);
    });

    it('проход завис, если пульса нет 15 минут', () => {
        expect(workerStall(status({ workerRunning: true, heartbeat: minutesAgo(25) }), NOW)?.minutes).toBe(25);
        expect(workerStall(status({ workerRunning: true, heartbeat: minutesAgo(5) }), NOW)).toBeNull();
    });
});

describe('трей', () => {
    it('сервис не отвечает: значок i-bubble-slash, пунктов ревью нет', () => {
        const model = trayModel(null, defaultPrefs(), NOW);
        expect(model.icon.glyph).toEqual({ kind: 'icon', id: 'i-bubble-slash' });
        expect(model.tooltip).toBe('PR Reviewer: сервис не отвечает');
        expect(texts(model.menu)).toEqual(['Сервис не отвечает', 'Выключить уведомления', 'Выйти из PR Reviewer']);
    });

    it('ожидание: галочка и число PR без ревью', () => {
        const model = trayModel(data(), defaultPrefs(), NOW);
        expect(model.icon).toMatchObject({ glyph: { kind: 'icon', id: 'i-bubble-check' }, count: 1, spin: false });
        expect(model.tooltip).toBe('PR Reviewer: ожидание\nPR без ревью на текущем коммите: 1');
        expect(model.menu[0]).toMatchObject({ text: 'Следующий проход через 12 мин' });
    });

    it('идёт ревью: крутится знак модели, в меню «Прервать ревью»', () => {
        const model = trayModel(data({ status: status({ workerRunning: true, heartbeat: minutesAgo(1), running: [{ repo: 'frontend', pr: 2828, agent: 'claude', role: 'first' }] }) }), defaultPrefs(), NOW);
        expect(model.icon).toMatchObject({ glyph: { kind: 'mark', agent: 'claude' }, spin: true });
        expect(model.tooltip.split('\n')[0]).toBe('PR Reviewer: ревью frontend #2828 · Claude (первым)');
        expect(model.menu.some((entry) => entry.kind === 'item' && entry.text === 'Прервать ревью')).toBe(true);
    });

    it('завис — оранжевый треугольник мигает; пауза; ошибка — красный', () => {
        expect(trayModel(data({ status: status({ workerRunning: true, heartbeat: minutesAgo(25) }) }), defaultPrefs(), NOW).icon).toMatchObject({ glyph: { id: 'i-warning-fill' }, color: 'orange', blink: true });
        expect(trayModel(data({ status: status({ paused: true }) }), defaultPrefs(), NOW).icon.glyph).toEqual({ kind: 'icon', id: 'i-pause-fill' });
        expect(trayModel(data({ status: status({ phase: 'error' }) }), defaultPrefs(), NOW).icon).toMatchObject({ glyph: { id: 'i-bubble-warning' }, color: 'red' });
    });

    it('уведомления выключены: строка срока и «Включить уведомления»', () => {
        const prefs = { ...defaultPrefs(), mutedUntil: muteUntil(2, NOW) };
        const items = texts(trayModel(data(), prefs, NOW).menu);
        expect(items).toContain('Уведомления: выключены до 16:00');
        expect(items).toContain('Выключить на другое время');
    });
});

describe('имена проекта из настроек', () => {
    const config = (patch: Partial<Data['config']>): Data['config'] => ({ repos: [], agents: {}, ...patch });

    it('по умолчанию в фон идёт ветка с любым ключом задачи Jira', () => {
        expect(isTaskBranch(config({}), 'feature/PROJ-1234-filter')).toBe(true);
        expect(isTaskBranch(config({}), 'hotfix/login')).toBe(false);
        expect(isTaskBranch(config({ branchPattern: 'release/' }), 'release/1.2')).toBe(true);
    });

    it('без qa.frontend и qa.backend тестирование выключено', () => {
        expect(qaConfigured(config({}))).toBe(false);
        expect(canTest(config({ qa: { frontend: 'frontend' } }), 'frontend')).toBe(false);
        expect(canTest(config({ qa: { frontend: 'frontend', backend: 'backend' } }), 'frontend')).toBe(true);
        expect(canTest(config({ qa: { frontend: 'frontend', backend: 'backend' } }), 'backend')).toBe(false);
    });

    it('префикс для показа отрезается только если задан', () => {
        expect(shortRepoName('team-frontend')).toBe('team-frontend');
        expect(shortRepoName('team-frontend', 'team-')).toBe('frontend');
        expect(shortRepoName('team-', 'team-')).toBe('team-');
    });
});
