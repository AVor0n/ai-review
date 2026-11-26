import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';
import { isPermissionGranted } from '@tauri-apps/plugin-notification';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Fragment, useCallback, useEffect, useState, type CSSProperties } from 'react';
import { errorText, type ApiClient } from '../api/client';
import { Icon } from '../components/Icon';
import { newLessons } from '../model/banners';
import { DEFAULT_BRANCH_PATTERN, agentIds, agentName, tokens } from '../model/derive';
import { muteUntil, isMuted, type Prefs } from '../model/prefs';
import { loadNotifications, muteSummary, saveNotifications, type NotificationSettings, KINDS } from '../model/notifications';
import type { Data } from '../model/types';
import { loadTheme, setTheme, type Theme } from '../theme';
import { BranchesSheet } from './BranchesSheet';
import { ConfigSheet } from './ConfigSheet';
import { NavRow, Select, Stepper, Switch, popupMenu } from './controls';
import {
    buildInfo,
    currentEffort,
    effortOptions,
    limitColor,
    limitView,
    modelChange,
    modelOptions,
    parseModels,
    POLLED_LIMITS,
    stepInterval,
    tokensSummary,
    type Models,
    type SettingsSheet,
} from './model';
import { NotificationsSheet } from './NotificationsSheet';
import { LogSheet } from './LogSheet';
import { errorsLastDay, type LogEntry } from './log';
import { AddRepoSheet, IgnoreSheet } from './RepoSheets';
import { TokensSheet } from './TokensSheet';

// Вкладка «Настройки» — перенос SettingsView, RepoRow, AgentRow и BuildInfoRow из menubar/SettingsView.swift.
// Разметка — шаблон tpl-settings макета 2026-11-26-tauri-settings.html
type Result = { error?: unknown };

const THEMES: { id: Theme; title: string }[] = [
    { id: 'system', title: 'Системная' },
    { id: 'light', title: 'Светлая' },
    { id: 'dark', title: 'Тёмная' },
];
const DIM = 'Сначала включите фоновое ревью наверху';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// Codex и Cursor отдают лимиты по сети: спрашиваем не чаще раза в 5 минут, своим таймером — модель без лимита не дёргает сеть при каждом открытии
let limitsRequestedAt = 0;

const tone = (color: string) => ({ '--c': color }) as CSSProperties;

export const SettingsScreen = ({
    api,
    data,
    memoryBroken,
    prefs,
    updatePrefs,
    platform,
    cli,
    logDir,
    logVersion,
    reposDir,
    canOpenInCode,
    sheet,
    setSheet,
    onOpenMemory,
    onCopy,
}: {
    api: ApiClient | null;
    data: Data;
    memoryBroken: Record<string, string>;
    prefs: Prefs;
    updatePrefs: (update: (previous: Prefs) => Prefs) => void;
    platform: 'mac' | 'win';
    cli: string;
    logDir: string | null;
    logVersion: number;
    reposDir: string | null;
    canOpenInCode: boolean;
    sheet: SettingsSheet | null;
    setSheet: (sheet: SettingsSheet | null) => void;
    onOpenMemory: (slug: string) => void;
    onCopy: (text: string) => Promise<boolean>;
}) => {
    const [theme, chooseTheme] = useState<Theme>(loadTheme);
    const [notifications, setNotifications] = useState<NotificationSettings>(loadNotifications);
    const [denied, setDenied] = useState(false);
    const [now, setNow] = useState(() => new Date());
    const [clones, setClones] = useState<Record<string, boolean>>({});
    const [cloning, setCloning] = useState<Set<string>>(new Set());
    const [cloneErrors, setCloneErrors] = useState<Record<string, string>>({});
    const [models, setModels] = useState<Models>({ codex: [], cursor: [] });
    const [error, setError] = useState<string | null>(null);
    const [log, setLog] = useState<LogEntry[]>([]);

    const { config, status } = data;
    const paused = status?.paused === true;
    const interval = config.intervalMinutes ?? 15;
    const muted = isMuted(prefs, now);

    const loadClones = useCallback(async () => {
        const { data: answer } = (await api?.GET('/clones')) ?? {};
        if (answer) setClones(answer as Record<string, boolean>);
    }, [api]);

    const loadModels = useCallback(async () => {
        const { data: answer } = (await api?.GET('/models')) ?? {};
        if (answer) setModels(parseModels(answer as Parameters<typeof parseModels>[0]));
        return answer as { cursor?: { at?: string } | null } | undefined;
    }, [api]);

    useEffect(() => {
        loadClones();
    }, [loadClones, config.repos.length]);

    // Журнал — и для счётчика ошибок в строке, и для листа; новые записи приходят событием log
    useEffect(() => {
        api?.GET('/log').then(({ data: answer }) => answer && setLog([...answer.entries].reverse()));
    }, [api, logVersion]);

    // Список моделей Cursor зависит от аккаунта и тянется из сети — обновляем его не чаще раза в сутки; лимиты Codex и Cursor — раз в 5 минут
    useEffect(() => {
        if (!api) return;
        loadModels().then(async (answer) => {
            const at = Date.parse(answer?.cursor?.at ?? '');
            if (config.agents.cursor && !(at > Date.now() - DAY)) {
                await api.POST('/agents/cursor/models');
                loadModels();
            }
        });
        const stale = POLLED_LIMITS.some((id) => config.agents[id] && !(Date.parse(data.limits[id]?.at ?? '') > Date.now() - 5 * MINUTE));
        if (stale && Date.now() - limitsRequestedAt > 5 * MINUTE) {
            limitsRequestedAt = Date.now();
            api.POST('/limits/refresh');
        }
        // Только при открытии вкладки, как onAppear в SwiftUI
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api]);

    // Раз в минуту — чтобы истёкшее «Выключены до …» сменилось само; заодно перечитываем запрет уведомлений
    useEffect(() => {
        const check = () => isPermissionGranted().then((granted) => setDenied(!granted), () => setDenied(false));
        check();
        const timer = setInterval(() => {
            setNow(new Date());
            check();
        }, MINUTE);
        return () => clearInterval(timer);
    }, []);

    const run = async (request: () => Promise<Result> | undefined) => {
        const answer = await request();
        const failure = answer?.error ? errorText(answer.error) : null;
        setError(failure);
        return failure;
    };

    const changeNotifications = (next: NotificationSettings) => {
        setNotifications(next);
        saveNotifications(next);
    };

    const clone = async (slug: string) => {
        if (!api) return;
        setCloning((current) => new Set([...current, slug]));
        const { error: failure } = await api.POST('/repos/{repo}/clone', { params: { path: { repo: slug } } });
        setCloning((current) => new Set([...current].filter((item) => item !== slug)));
        setCloneErrors((current) => {
            const next = { ...current };
            if (failure) next[slug] = errorText(failure);
            else delete next[slug];
            return next;
        });
        loadClones();
    };

    const remove = async (slug: string) => {
        const confirmed = await ask('Ревью этого репозитория прекратится, служебная копия будет удалена. Комментарии в Bitbucket и статистика останутся.', {
            title: `Отключить ${slug}?`,
            kind: 'warning',
            okLabel: 'Отключить и удалить клон',
            cancelLabel: 'Отмена',
        });
        if (confirmed && api) run(() => api.DELETE('/repos/{repo}', { params: { path: { repo: slug } } }));
    };

    const ignore = async (method: 'POST' | 'DELETE', pattern: string) => {
        if (!api) return 'Сервис не отвечает';
        const { error: failure } = method === 'POST' ? await api.POST('/settings/ignore', { body: { pattern } }) : await api.DELETE('/settings/ignore', { body: { pattern } });
        return failure ? errorText(failure) : null;
    };

    const openSystemNotifications = () => invoke('open_notification_settings').catch((reason) => setError(String(reason)));

    const footer = [
        paused ? 'Ручной запуск из обзора работает всегда.' : 'Выключение фонового ревью прерывает идущее ревью.',
        denied
            ? platform === 'win'
                ? 'Windows запретила уведомления — включите их в параметрах Windows.'
                : 'macOS запретила уведомления — включите их в системных настройках.'
            : (() => {
                  const own = config.repos.map((repo) => repo.slug).filter((slug) => notifications.repos[slug]);
                  return own.length ? `Свои уведомления у ${own.join(', ')}.` : '';
              })(),
    ]
        .filter(Boolean)
        .join(' ');

    const notificationsValue = denied ? (platform === 'win' ? 'Запрещены в Windows' : 'Запрещены в macOS') : muted ? muteSummary(prefs.mutedUntil, now) : `${notifications.all.enabled.length} из ${KINDS.length}`;
    const allTokens = tokens(data, now);
    const tokenValue = tokensSummary(allTokens, now);
    const build = buildInfo(__BUILD__.commit, __BUILD__.date, __BUILD__.dirty, now);

    const repoRow = (repo: Data['config']['repos'][number]) => {
        const fresh = newLessons(data.memory[repo.slug] ?? [], prefs.memorySeenAt[repo.slug]).length;
        const broken = memoryBroken[repo.slug];
        const badge = broken ? 'var(--red)' : fresh > 0 ? 'var(--accent)' : null;
        const cloned = clones[repo.slug] === true;
        const subtitle = repo.source ? `${repo.remote ?? ''} · первый клон с ${repo.source}` : (repo.remote ?? '');
        const url = `https://bitbucket.org/${repo.workspace}/${repo.slug}`;
        return (
            // У неактивного переключателя подсказка может не показаться — дублируем её на всю строку
            <div className="settings-row" title={paused ? DIM : undefined}>
                <span className="icon-tile" style={repo.paused || paused ? tone('var(--gray)') : undefined}>
                    <Icon id="i-repo-fill" />
                </span>
                <span className="settings-row__text">
                    <span>
                        {repo.workspace}/{repo.slug}
                    </span>
                    <span className="settings-row__sub" title={subtitle}>
                        {subtitle}
                    </span>
                    {cloneErrors[repo.slug] && (
                        <span className="settings-row__sub selectable" style={{ color: 'var(--red)', whiteSpace: 'normal', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}>
                            {cloneErrors[repo.slug]}
                        </span>
                    )}
                </span>
                {cloning.has(repo.slug) ? (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-callout)', color: 'var(--label-2)' }}>
                        <Icon id="i-spinner" />
                        Скачивается…
                    </span>
                ) : (
                    !cloned && (
                        <button className="link-button" onClick={() => clone(repo.slug)}>
                            Скачать
                        </button>
                    )
                )}
                <button
                    className={`memory-chip${badge ? ' memory-chip--marked' : ''}`}
                    style={badge ? tone(badge) : undefined}
                    title={broken ? `Память повреждена: ${broken}` : fresh > 0 ? `Новых правил: ${fresh}. Откройте, чтобы посмотреть` : 'Память ревьюеров: правила из ответов команды на замечания'}
                    onClick={() => onOpenMemory(repo.slug)}
                >
                    <Icon id="i-brain" />
                    {data.memory[repo.slug]?.length ?? 0}
                </button>
                <button
                    className="icon-button"
                    title="Ещё"
                    onClick={() =>
                        popupMenu([
                            { text: 'Открыть в Bitbucket', action: () => openUrl(url).catch(() => {}) },
                            { text: 'Память ревьюеров…', action: () => onOpenMemory(repo.slug) },
                            {
                                text: platform === 'win' ? 'Показать служебную копию в Проводнике' : 'Показать служебную копию в Finder',
                                enabled: cloned && !!reposDir,
                                action: () => invoke('reveal_path', { path: `${reposDir}/${repo.slug}` }).catch((reason) => setError(String(reason))),
                            },
                            'separator',
                            { text: 'Отключить…', action: () => remove(repo.slug) },
                        ])
                    }
                >
                    <Icon id="i-more" />
                </button>
                {/* Пока весь сервис на паузе, переключатель репозитория ни на что не влияет: приглушён и не переключается */}
                <Switch
                    checked={!repo.paused}
                    disabled={paused}
                    title={paused ? DIM : repo.paused ? 'Фоновое ревью репозитория выключено' : 'Фоновое ревью репозитория включено'}
                    onChange={(on) => api && run(() => api.POST(on ? '/repos/{repo}/resume' : '/repos/{repo}/pause', { params: { path: { repo: repo.slug } } }))}
                />
            </div>
        );
    };

    const agentRow = (id: string) => {
        const agent = config.agents[id];
        const current = agent?.model ?? '';
        const effort = currentEffort(id, agent);
        const limit = limitView(id, data.limits[id], agentName(config, id), now);
        const setAgent = (body: { model?: string; effort?: string; label?: string; auto?: boolean }) => api && run(() => api.PUT('/agents/{id}', { params: { path: { id } }, body }));
        return (
            <div className="settings-row">
                <span className={`icon-tile icon-tile--track${agent?.auto === false ? ' icon-tile--off' : ''}`}>
                    <span className={`model-mark model--${id}`} />
                </span>
                <span className="settings-row__text">
                    <span>{agentName(config, id)}</span>
                    <span className={`limit${limit.low ? ' limit--low' : ''}${limit.none ? ' limit--none' : ''}`} title={limit.hint || undefined}>
                        {limit.bar !== null && (
                            <span className="limit-bar">
                                <span style={{ '--remaining': `${limit.bar}%`, '--c': limitColor(limit) } as CSSProperties} />
                            </span>
                        )}
                        {limit.warning && <Icon id="i-warning-fill" className="icon limit__stale" />}
                        {limit.text}
                    </span>
                </span>
                <Select options={modelOptions(id, current, models)} value={current} width={160} title="Модель" onSelect={(value) => setAgent(modelChange(id, value, agent, models))} />
                {id === 'cursor' ? (
                    // У Cursor уровень рассуждений — часть id модели: grok-4.7-high, claude-opus-5-5-xhigh
                    <span className="select-note" title="У Cursor уровень reasoning выбирается вместе с моделью">
                        в названии модели
                    </span>
                ) : (
                    <Select options={effortOptions(id, current, models)} value={effort} width={160} title="Уровень reasoning" onSelect={(value) => setAgent({ effort: value })} />
                )}
                <Switch
                    checked={agent?.auto !== false}
                    title="Участвует ли модель в фоновом ревью. Выключенная в фоне не ревьюит и не отвечает в тредах, но запускается по клику на её иконку в обзоре"
                    onChange={(auto) => setAgent({ auto })}
                />
            </div>
        );
    };

    const prs = config.repos.flatMap((repo) => (data.snapshots[repo.slug]?.prs ?? []).filter((pr) => !pr.draft));

    return (
        <>
            <div className="scroll" style={{ paddingTop: 8 }}>
                <div className="sections">
                    {error && (
                        <div className="banner banner--alert" role="alert">
                            <Icon id="i-warning-fill" className="icon banner__icon" />
                            <div className="banner__body">
                                <div className="banner__title">Не удалось выполнить команду</div>
                                <div className="banner__text banner__text--clamp selectable">{error}</div>
                            </div>
                            <div className="banner__actions">
                                <button className="close-button" title="Скрыть" onClick={() => setError(null)}>
                                    <Icon id="i-close" />
                                </button>
                            </div>
                        </div>
                    )}
                    <div className="section">
                        <div className="section__header">Общие</div>
                        <div className="section__card">
                            <div className="settings-row">
                                <span className="settings-row__title">Тема</span>
                                <div className="segmented segmented--dimension">
                                    {THEMES.map((item) => (
                                        <button
                                            key={item.id}
                                            className="segmented__item"
                                            aria-selected={theme === item.id}
                                            onClick={() => {
                                                chooseTheme(item.id);
                                                setTheme(item.id);
                                            }}
                                        >
                                            {item.title}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div className="row-divider" />
                            <div className="settings-row" title="Новые коммиты и ответы в тредах включённых репозиториев проверяются по расписанию. Выключение прерывает идущее ревью; по клику на иконку модели в обзоре ревью запускается всегда">
                                <span className="settings-row__title">Фоновое ревью</span>
                                <Switch checked={!paused} onChange={(on) => api && run(() => api.POST(on ? '/resume' : '/pause'))} />
                            </div>
                            <div className="row-divider" />
                            <div className={`settings-row${paused ? ' settings-row--dim' : ''}`} title={paused ? DIM : 'Как часто искать новые коммиты и ответы в тредах. Действует со следующей минуты'}>
                                <span className="settings-row__title">Проверять каждые</span>
                                <span className="settings-row__value">{interval} мин</span>
                                <Stepper
                                    disabled={paused}
                                    onStep={(direction) => {
                                        const next = stepInterval(interval, direction);
                                        if (next && api) run(() => api.PUT('/settings/interval', { body: { minutes: next } }));
                                    }}
                                />
                            </div>
                            <div className="row-divider" />
                            <NavRow title="Уведомления" value={notificationsValue} color={denied || muted ? 'var(--orange)' : null} onClick={() => setSheet('notifications')} />
                        </div>
                        <div className="section__footer">{footer}</div>
                    </div>
                    <div className="section">
                        <div className="section__header">Подключённые репозитории</div>
                        <div className="section__card">
                            {config.repos.map((repo) => (
                                <Fragment key={repo.slug}>
                                    {repoRow(repo)}
                                    <div className="row-divider row-divider--tile" />
                                </Fragment>
                            ))}
                            <button className="settings-row settings-row--nav settings-row--add" onClick={() => setSheet('add-repo')}>
                                <span className="settings-row__lead">
                                    <Icon id="i-plus-circle-fill" />
                                </span>
                                <span className="settings-row__title">Добавить репозиторий</span>
                            </button>
                        </div>
                    </div>
                    <div className="section">
                        <div className="section__header">Модели</div>
                        <div className="section__card">
                            {agentIds(config).map((id, index) => (
                                <Fragment key={id}>
                                    {index > 0 && <div className="row-divider row-divider--tile" />}
                                    {agentRow(id)}
                                </Fragment>
                            ))}
                        </div>
                        <div className="section__footer">Выключенная модель запускается только по клику на её иконку в обзоре.</div>
                    </div>
                    <div className="section">
                        <div className="section__header">Дополнительно</div>
                        <div className="section__card">
                            <NavRow
                                title="Ветки для ревью"
                                value={config.branchPattern ?? DEFAULT_BRANCH_PATTERN}
                                mono
                                hint="Фоновое ревью берёт только PR, исходная ветка которых подходит под шаблон. Вручную можно отревьюить любой PR"
                                onClick={() => setSheet('branches')}
                            />
                            <div className="row-divider" />
                            <NavRow title="Исключения из диффа" value={String(config.ignorePaths?.length ?? 0)} onClick={() => setSheet('ignore')} />
                            <div className="row-divider" />
                            <NavRow title="Токены" value={tokenValue.text} color={tokenValue.color} hint="Сроки токенов Bitbucket и моделей; за 14 дней до истечения в обзоре появится предупреждение" onClick={() => setSheet('tokens')} />
                            <div className="row-divider" />
                            <NavRow title="config.json" onClick={() => setSheet('config')} />
                            <div className="row-divider" />
                            <NavRow title="Журнал" value={errorsLastDay(log, now)} color="var(--orange)" hint="Журнал сервиса: последние 300 записей" onClick={() => setSheet('log')} />
                        </div>
                        <div className="section__footer">Шаблон веток касается только фонового ревью.</div>
                    </div>
                    {build && (
                        <div className="build-info selectable" title={build.hint}>
                            {build.text}
                            {build.dirty && (
                                <>
                                    {' '}
                                    <span className="tag" style={{ '--tag-color': 'var(--orange)' } as CSSProperties}>
                                        правки не закоммичены
                                    </span>
                                </>
                            )}
                        </div>
                    )}
                </div>
            </div>
            {sheet === 'notifications' && (
                <NotificationsSheet
                    settings={notifications}
                    onChange={changeNotifications}
                    repos={config.repos.map((repo) => repo.slug)}
                    mutedUntil={prefs.mutedUntil}
                    muted={muted}
                    onMute={(hours) => updatePrefs((previous) => ({ ...previous, mutedUntil: muteUntil(hours) }))}
                    onUnmute={() => updatePrefs((previous) => ({ ...previous, mutedUntil: null }))}
                    denied={denied}
                    platform={platform}
                    onOpenSystem={openSystemNotifications}
                    onClose={() => setSheet(null)}
                />
            )}
            {sheet === 'tokens' && (
                <TokensSheet
                    tokens={allTokens}
                    secrets={data.secrets}
                    config={config}
                    platform={platform}
                    cli={cli}
                    onLifetime={(id, days) => api && run(() => api.PUT('/tokens/{id}/lifetime', { params: { path: { id } }, body: { days } }))}
                    onCopy={onCopy}
                    onClose={() => setSheet(null)}
                />
            )}
            {sheet === 'branches' && (
                <BranchesSheet
                    saved={config.branchPattern ?? DEFAULT_BRANCH_PATTERN}
                    prs={prs}
                    onSave={(pattern) => api && run(() => api.PUT('/settings/branches', { body: { pattern } }))}
                    onClose={() => setSheet(null)}
                />
            )}
            {sheet === 'add-repo' && (
                <AddRepoSheet
                    onAdd={async (ref) => {
                        if (!api) return 'Сервис не отвечает';
                        const { error: failure } = await api.POST('/repos', { body: { ref } });
                        if (!failure) loadClones();
                        return failure ? errorText(failure) : null;
                    }}
                    onClose={() => setSheet(null)}
                />
            )}
            {sheet === 'ignore' && (
                <IgnoreSheet
                    patterns={config.ignorePaths ?? []}
                    onAdd={(pattern) => ignore('POST', pattern)}
                    onRemove={(pattern) => ignore('DELETE', pattern)}
                    onClose={() => setSheet(null)}
                />
            )}
            {sheet === 'log' && <LogSheet entries={log} file={logDir ? `${logDir}/worker.log` : null} onError={setError} onClose={() => setSheet(null)} />}
            {sheet === 'config' && api && <ConfigSheet api={api} canOpenInCode={canOpenInCode} onOpenInCode={(path) => invoke('open_in_code', { path }).catch((reason) => setError(String(reason)))} onClose={() => setSheet(null)} />}
        </>
    );
};
