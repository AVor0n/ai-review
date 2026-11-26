import { listen } from '@tauri-apps/api/event';
import { ask } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorText, type ApiClient, type Schemas } from './api/client';
import type { ChangeEvent } from './api/events';
import { Overview, type OverviewHandlers } from './components/Overview';
import { Stub } from './components/Stub';
import { StatsScreen } from './stats/StatsScreen';
import { MemorySheet } from './memory/MemorySheet';
import { ArchSheet } from './arch/ArchSheet';
import { updateJobs } from './memory/jobs';
import { newLessons } from './model/banners';
import { invoke } from '@tauri-apps/api/core';
import { useData } from './data';
import { banners as buildBanners, serviceDownBanner, type Banner, type BannerAction } from './model/banners';
import { archAgentName, threads } from './model/derive';
import { parse } from './model/format';
import { loadPrefs, muteUntil, savePrefs, withSeenRepos, type Prefs } from './model/prefs';
import { stub as stubContent, TABS, type CliEnv, type StubTarget, type TabId } from './model/stubs';
import { trayModel } from './model/tray';
import type { PullRequest } from './model/types';
import { notify, reviewNotice } from './notify';
import { isWindows, serviceDown, useService } from './service';
import { applyTrayIcon, applyTrayMenu } from './trayIcon';

type StatsEntry = Parameters<typeof reviewNotice>[0];
type Command = '/run-now' | '/stop' | '/pause' | '/resume' | '/sync';

// Сервис молчит дольше минуты — сообщаем уведомлением: поповер в это время обычно закрыт
const DOWN_NOTICE_MS = 60_000;
// Список PR обновляется при открытии поповера, но не чаще раза в минуту: у токена Bitbucket лимит запросов в час
const SYNC_ON_OPEN_AFTER_MS = 60_000;
// Минуты в шапке и «обновлено N минут назад» пересчитываются сами
const TICK_MS = 30_000;

const platform = isWindows() ? 'win' : 'mac';

export const App = () => {
    const { data, memoryBroken, onEvent, refreshSecrets } = useData();
    const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
    const [now, setNow] = useState(() => new Date());
    const [stub, setStub] = useState<StubTarget | null>(null);
    // Перенесённые экраны; неперенесённые открывают заглушку поверх них
    const [screen, setScreen] = useState<'overview' | 'stats'>('overview');
    const [statsVersion, setStatsVersion] = useState(0);
    // Лист «Память ревьюеров» поверх поповера, на той вкладке, где его открыли
    const [memorySheet, setMemorySheet] = useState<string | null>(null);
    const [archSheet, setArchSheet] = useState<{ repo: string; pr: number } | null>(null);
    const [canOpenInCode, setCanOpenInCode] = useState(false);
    useEffect(() => {
        invoke<boolean>('code_available').then(setCanOpenInCode, () => setCanOpenInCode(false));
    }, []);
    // Новые правила считаются просмотренными, когда лист закрыли: пока он открыт, точки помогают их найти
    const closeMemorySheet = useCallback(() => {
        setMemorySheet((slug) => {
            if (slug) {
                updateJobs(slug, { applied: undefined, restored: undefined });
                updateMemorySeen.current(slug);
            }
            return null;
        });
    }, []);
    const updateMemorySeen = useRef<(slug: string) => void>(() => {});
    const [bannersExpanded, setBannersExpanded] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [syncError, setSyncError] = useState<string | null>(null);
    const seenStatsAt = useRef(new Date().toISOString());
    const apiRef = useRef<ApiClient | null>(null);
    const healthRef = useRef<Schemas['Health'] | null>(null);
    const dataRef = useRef(data);
    dataRef.current = data;

    const updatePrefs = useCallback((change: (prefs: Prefs) => Prefs) => {
        setPrefs((previous) => {
            const next = change(previous);
            savePrefs(next);
            return next;
        });
    }, []);

    const onChange = useCallback(
        async (event: ChangeEvent, api: ApiClient) => {
            await onEvent(api, event);
            if (['stats', 'fixes', 'arch', 'qa', 'backlog', 'memory'].includes(event.type)) setStatsVersion((value) => value + 1);
            if (event.type !== 'stats') return;
            // since включает границу: запись с тем же временем уже показана
            const since = seenStatsAt.current;
            const { data: entries } = await api.GET('/stats', { params: { query: { since } } });
            const fresh = ((entries ?? []) as StatsEntry[]).filter((entry) => entry.at > since);
            if (fresh.length) seenStatsAt.current = fresh[fresh.length - 1].at;
            for (const entry of fresh.filter((item) => item.pass !== 'replies')) {
                const notice = reviewNotice(entry, (id) => dataRef.current.config.agents[id]?.shortName ?? id);
                notify(notice.title, notice.body);
            }
        },
        [onEvent],
    );

    const { connection, retry } = useService(onChange);
    apiRef.current = connection.phase === 'up' ? connection.api : null;
    if (connection.phase === 'up') healthRef.current = connection.health;
    const offline = connection.phase === 'down';
    const hasData = !!data.status;

    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), TICK_MS);
        return () => clearInterval(timer);
    }, []);

    // Новые репозитории начинают с «вся память просмотрена»
    useEffect(() => {
        if (data.config.repos.length) updatePrefs((previous) => withSeenRepos(previous, data.config.repos.map((repo) => repo.slug)));
    }, [data.config.repos, updatePrefs]);

    const command = useCallback(
        async (path: Command) => {
            const api = apiRef.current;
            if (!api) return notify('PR Reviewer: сервис не запущен', serviceDown().text);
            if (path === '/sync') setSyncing(true);
            const { error } = await api.POST(path);
            if (path === '/sync') setSyncing(false);
            setSyncError(error ? errorText(error) : null);
        },
        [],
    );

    const syncIfStale = useCallback(() => {
        const current = dataRef.current;
        const stale = current.config.repos.some((repo) => {
            const fetched = parse(current.snapshots[repo.slug]?.fetchedAt);
            return !fetched || Date.now() - fetched.getTime() > SYNC_ON_OPEN_AFTER_MS;
        });
        if (stale && apiRef.current) command('/sync');
    }, [command]);

    // Rust ставит окно у значка и передаёт, где центр стрелки. При каждом открытии — «Обзор», баннеры свёрнуты
    useEffect(() => {
        const unlisten = listen<{ arrowX: number }>('popover-shown', ({ payload }) => {
            document.documentElement.style.setProperty('--arrow-x', `${payload.arrowX}px`);
            setStub(null);
            setScreen('overview');
            closeMemorySheet();
            setArchSheet(null);
            setBannersExpanded(false);
            setNow(new Date());
            // Статус — заново: при открытии поповера шапка и баннеры не должны показывать устаревший проход
            if (apiRef.current) {
                refreshSecrets(apiRef.current);
                onEvent(apiRef.current, { type: 'status', at: new Date().toISOString() });
            }
            syncIfStale();
        });
        return () => {
            unlisten.then((stop) => stop());
        };
    }, [refreshSecrets, syncIfStale, onEvent, closeMemorySheet]);

    // Первое подключение — тоже повод обновить список PR, если он старый
    const firstLoad = useRef(true);
    useEffect(() => {
        if (hasData && firstLoad.current) {
            firstLoad.current = false;
            syncIfStale();
        }
    }, [hasData, syncIfStale]);

    // Одно уведомление на один простой: каждая неудачная попытка даёт новый объект связи, но since у простоя тот же
    const downSince = connection.phase === 'down' ? connection.since : null;
    useEffect(() => {
        if (downSince === null) return;
        const { text, command } = serviceDown();
        const timer = setTimeout(() => notify('PR Reviewer: сервис не отвечает', `${text}\n${command}`), Math.max(0, downSince + DOWN_NOTICE_MS - Date.now()));
        return () => clearTimeout(timer);
    }, [downSince]);

    // Значок, подсказка и меню трея. Пока идёт первое подключение, остаётся стартовый значок
    useEffect(() => {
        if (connection.phase === 'connecting' || (connection.phase === 'up' && !hasData)) return;
        const tray = trayModel(connection.phase === 'up' ? data : null, prefs, now);
        applyTrayIcon(tray.icon, tray.tooltip);
        applyTrayMenu(tray.menu);
    }, [connection.phase, hasData, data, prefs, now]);

    // Меню по правому клику: Rust передаёт выбранный пункт
    useEffect(() => {
        const unlisten = listen<string>('menu', ({ payload }) => {
            if (payload === 'unmute') return updatePrefs((previous) => ({ ...previous, mutedUntil: null }));
            if (payload.startsWith('mute:')) {
                const hours = payload === 'mute:forever' ? null : Number(payload.slice('mute:'.length));
                return updatePrefs((previous) => ({ ...previous, mutedUntil: muteUntil(hours) }));
            }
            // pause в CLI заодно прерывает идущее ревью
            if (payload === 'toggle-pause') return command(dataRef.current.status?.paused ? '/resume' : '/pause');
            if (payload === 'run-now' || payload === 'stop') return command(`/${payload}`);
        });
        return () => {
            unlisten.then((stop) => stop());
        };
    }, [command, updatePrefs]);

    const copy = useCallback((text: string) => navigator.clipboard.writeText(text).catch(() => {}), []);

    const runAction = useCallback(async (request: () => Promise<{ error?: unknown }>) => {
        const { error } = await request();
        setSyncError(error ? errorText(error as Schemas['Error']) : null);
    }, []);

    updateMemorySeen.current = (slug) => updatePrefs((previous) => ({ ...previous, memorySeenAt: { ...previous.memorySeenAt, [slug]: new Date().toISOString() } }));

    const handlers: OverviewHandlers = {
        command,
        stub: setStub,
        open: (url) => openUrl(url).catch(() => {}),
        review: (repo, pr, agent) => apiRef.current && runAction(() => apiRef.current!.POST('/reviews', { body: { repo, pr, agent } })),
        // Подтверждения — системный диалог с текстами из OverviewView.swift
        fix: async (repo: string, pr: PullRequest, rebase: boolean) => {
            const conflicts = pr.conflicts === true ? ', будут конфликты — их разрешит Claude, а если вариант неочевиден, rebase отменится' : '';
            const confirmed = await ask(
                rebase
                    ? `Ветка ${pr.source} отстала от ${pr.destination} на ${pr.behind ?? 0} коммит(ов)${conflicts}. После rebase прогоняются проверки и делается push --force-with-lease. Работа идёт в отдельной копии, перед изменениями создаётся резервная ветка.`
                    : `Claude перенесёт ветку ${pr.source} на свежую ${pr.destination}, исправит открытые замечания (${threads(pr).open}), закоммитит, прогонит проверки и, если они прошли, сделает push --force-with-lease. Работа идёт в отдельной копии и может занять до часа. Перед изменениями создаётся резервная ветка.`,
                { title: rebase ? `Сделать rebase #${pr.id} на ${pr.destination}?` : `Доработать #${pr.id} по замечаниям?`, kind: 'info', okLabel: rebase ? 'Rebase' : 'Доработать', cancelLabel: 'Отмена' },
            );
            if (confirmed && apiRef.current) runAction(() => apiRef.current!.POST('/fixes/{repo}/{pr}', { params: { path: { repo, pr: pr.id } }, body: { rebase } }));
        },
        arch: async (repo: string, pr: PullRequest) => {
            const confirmed = await ask(
                `${archAgentName(dataRef.current.config)} оценит решение целиком: цель, альтернативы с ценой переделки, где можно проще, серьёзные риски. Это займёт до часа. Отчёт останется только здесь, в PR ничего не публикуется.`,
                { title: `Архитектурное ревью #${pr.id}?`, kind: 'info', okLabel: 'Запустить', cancelLabel: 'Отмена' },
            );
            if (confirmed && apiRef.current) runAction(() => apiRef.current!.POST('/arch/{repo}/{pr}', { params: { path: { repo, pr: pr.id } } }));
        },
        report: (kind, repo, pr) => (kind === 'arch' ? setArchSheet({ repo, pr }) : setStub({ kind, repo, pr })),
        toggleRepo: (slug) =>
            updatePrefs((previous) => ({
                ...previous,
                collapsedRepos: previous.collapsedRepos.includes(slug) ? previous.collapsedRepos.filter((item) => item !== slug) : [...previous.collapsedRepos, slug],
            })),
        banner: (action: BannerAction) => {
            if (action.kind === 'stub') setStub(action.target);
            else if (action.kind === 'memory') setMemorySheet(action.slug);
            else if (action.kind === 'stop') command('/stop');
            else if (action.kind === 'copy') copy(action.text);
            else retry();
        },
        closeBanner: (close: NonNullable<Banner['close']>) => {
            const at = new Date().toISOString();
            updatePrefs((previous) =>
                close.kind === 'token'
                    ? { ...previous, tokenBannerClosedAt: { ...previous.tokenBannerClosedAt, [close.key]: at } }
                    : { ...previous, memoryBannerClosedAt: { ...previous.memoryBannerClosedAt, [close.key]: at } },
            );
        },
        toggleBanners: () => setBannersExpanded((value) => !value),
    };

    const banners = useMemo(() => {
        const list = hasData ? buildBanners(data, prefs, { syncError, memoryBroken }, now) : [];
        return offline ? [serviceDownBanner(serviceDown()), ...list] : list;
    }, [hasData, data, prefs, syncError, memoryBroken, now, offline]);

    // Пути CLI и журнала в WSL — из /health; до первого ответа сервиса — как ставит install.sh
    const env: CliEnv = { cli: healthRef.current?.cli ?? '~/pr-reviewer/bin/pr-reviewer', logDir: healthRef.current?.logDir ?? '~/.local/state/pr-reviewer' };
    const shownStub = stub ? stubContent(stub, platform, env) : null;
    const tab: TabId = shownStub?.tab ?? screen;

    // Рамка — классы дизайн-системы (product/design/web/components.css): на Mac стрелка к значку, на Windows без неё
    return (
        <div className={`window-frame window-frame--${platform}`}>
            <div className={`popover-frame popover-frame--${platform}`}>
                {platform === 'mac' && (
                    <svg className="popover__arrow" viewBox="0 0 24 11" aria-hidden="true">
                        <path d="M0 11C5 11 8.5 1 12 1S19 11 24 11Z" fill="currentColor" />
                    </svg>
                )}
                <main className="popover app">
                    <div className="tabs">
                        <div className="segmented" role="tablist">
                            {TABS.map((item) => (
                                <button key={item.id} className="segmented__item" role="tab" aria-selected={tab === item.id} onClick={() => {
                                        if (item.id === 'overview' || item.id === 'stats') {
                                            setScreen(item.id);
                                            setStub(null);
                                        } else setStub({ kind: 'tab', tab: item.id });
                                    }}>
                                    {item.title}
                                </button>
                            ))}
                        </div>
                    </div>
                    {shownStub ? (
                        <Stub stub={shownStub} onCopy={copy} />
                    ) : screen === 'stats' ? (
                        <StatsScreen api={connection.phase === 'up' ? connection.api : null} data={data} version={statsVersion} />
                    ) : (
                        <Overview state={{ offline, data: hasData ? data : null, banners, bannersExpanded, collapsed: prefs.collapsedRepos, syncing, now }} on={handlers} />
                    )}
                    {archSheet && connection.phase === 'up' && (
                        <ArchSheet api={connection.api} data={data} repo={archSheet.repo} prId={archSheet.pr} onRerun={(pr) => handlers.arch(archSheet.repo, pr)} onClose={() => setArchSheet(null)} />
                    )}
                    {memorySheet && connection.phase === 'up' && (
                        <MemorySheet
                            api={connection.api}
                            slug={memorySheet}
                            memoryPath={`${connection.health.dataDir}/memory/${memorySheet}.json`}
                            canOpenInCode={canOpenInCode}
                            openInCode={(path) => invoke('open_in_code', { path }).catch(() => {})}
                            fresh={new Set(newLessons(data.memory[memorySheet] ?? [], prefs.memorySeenAt[memorySheet]).map((lesson) => lesson.id))}
                            version={statsVersion}
                            onClose={closeMemorySheet}
                        />
                    )}
                </main>
            </div>
        </div>
    );
};
