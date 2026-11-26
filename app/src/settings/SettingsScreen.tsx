import { invoke } from '@tauri-apps/api/core';
import { confirm } from '../dialog';
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
import { setLangSetting, t, useLangSetting, type LangSetting } from '../i18n';
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
import { errorsLastDay, LOG_LIMIT, type LogEntry } from './log';
import { AddRepoSheet, IgnoreSheet } from './RepoSheets';
import { TokensSheet } from './TokensSheet';

// Вкладка «Настройки» — перенос SettingsView, RepoRow, AgentRow и BuildInfoRow из menubar/SettingsView.swift.
// Разметка — шаблон tpl-settings макета 2026-11-26-tauri-settings.html
type Result = { error?: unknown };

const THEMES: Theme[] = ['system', 'light', 'dark'];
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
    const language = useLangSetting();
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
        const confirmed = await confirm(t('settings.repos.remove.message'), {
            title: t('settings.repos.remove.title', { repo: slug }),
            kind: 'warning',
            okLabel: t('settings.repos.remove.confirm'),
            cancelLabel: t('common.action.cancel'),
        });
        if (confirmed && api) run(() => api.DELETE('/repos/{repo}', { params: { path: { repo: slug } } }));
    };

    const ignore = async (method: 'POST' | 'DELETE', pattern: string) => {
        if (!api) return t('settings.error.noService');
        const { error: failure } = method === 'POST' ? await api.POST('/settings/ignore', { body: { pattern } }) : await api.DELETE('/settings/ignore', { body: { pattern } });
        return failure ? errorText(failure) : null;
    };

    const openSystemNotifications = () => invoke('open_notification_settings').catch((reason) => setError(String(reason)));

    const footer = [
        paused ? t('settings.general.footer.manual') : t('settings.general.footer.stops'),
        denied
            ? platform === 'win'
                ? t('settings.general.footer.deniedWin')
                : t('settings.general.footer.deniedMac')
            : (() => {
                  const own = config.repos.map((repo) => repo.slug).filter((slug) => notifications.repos[slug]);
                  return own.length ? t('settings.general.footer.ownRepos', { repos: own.join(', ') }) : '';
              })(),
    ]
        .filter(Boolean)
        .join(' ');

    const notificationsValue = denied ? t(`settings.general.notificationsDenied.${platform}`) : muted ? muteSummary(prefs.mutedUntil, now) : t('settings.general.notificationsCount', { enabled: notifications.all.enabled.length, total: KINDS.length });
    const dim = t('settings.general.dim');
    const allTokens = tokens(data, now);
    const tokenValue = tokensSummary(allTokens, now);
    const build = buildInfo(__BUILD__.commit, __BUILD__.date, __BUILD__.dirty, now);

    const repoRow = (repo: Data['config']['repos'][number]) => {
        const fresh = newLessons(data.memory[repo.slug] ?? [], prefs.memorySeenAt[repo.slug]).length;
        const broken = memoryBroken[repo.slug];
        const badge = broken ? 'var(--red)' : fresh > 0 ? 'var(--accent)' : null;
        const cloned = clones[repo.slug] === true;
        const subtitle = repo.source ? t('settings.repos.firstClone', { remote: repo.remote ?? '', source: repo.source }) : (repo.remote ?? '');
        const url = `https://bitbucket.org/${repo.workspace}/${repo.slug}`;
        return (
            // У неактивного переключателя подсказка может не показаться — дублируем её на всю строку
            <div className="settings-row" title={paused ? dim : undefined}>
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
                        {t('settings.repos.downloading')}
                    </span>
                ) : (
                    !cloned && (
                        <button className="link-button" onClick={() => clone(repo.slug)}>
                            {t('settings.repos.download')}
                        </button>
                    )
                )}
                <button
                    className={`memory-chip${badge ? ' memory-chip--marked' : ''}`}
                    style={badge ? tone(badge) : undefined}
                    title={broken ? t('settings.repos.memoryBroken', { reason: broken }) : fresh > 0 ? t('settings.repos.memoryNew', { count: fresh }) : t('settings.repos.memoryHint')}
                    onClick={() => onOpenMemory(repo.slug)}
                >
                    <Icon id="i-brain" />
                    {data.memory[repo.slug]?.length ?? 0}
                </button>
                <button
                    className="icon-button"
                    title={t('common.action.more')}
                    onClick={() =>
                        popupMenu([
                            { text: t('settings.repos.openBitbucket'), action: () => openUrl(url).catch(() => {}) },
                            { text: t('settings.repos.memory'), action: () => onOpenMemory(repo.slug) },
                            {
                                text: platform === 'win' ? t('settings.repos.revealWin') : t('settings.repos.revealMac'),
                                enabled: cloned && !!reposDir,
                                action: () => invoke('reveal_path', { path: `${reposDir}/${repo.slug}` }).catch((reason) => setError(String(reason))),
                            },
                            'separator',
                            { text: t('settings.repos.disconnect'), action: () => remove(repo.slug) },
                        ])
                    }
                >
                    <Icon id="i-more" />
                </button>
                {/* Пока весь сервис на паузе, переключатель репозитория ни на что не влияет: приглушён и не переключается */}
                <Switch
                    checked={!repo.paused}
                    disabled={paused}
                    title={paused ? dim : repo.paused ? t('settings.repos.paused') : t('settings.repos.active')}
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
                <Select options={modelOptions(id, current, models)} value={current} width={160} title={t('settings.models.model')} onSelect={(value) => setAgent(modelChange(id, value, agent, models))} />
                {id === 'cursor' ? (
                    // У Cursor уровень рассуждений — часть id модели: grok-4.7-high, claude-opus-5-5-xhigh
                    <span className="select-note" title={t('settings.models.cursorEffortHint')}>
                        {t('settings.models.cursorEffort')}
                    </span>
                ) : (
                    <Select options={effortOptions(id, current, models)} value={effort} width={160} title={t('settings.models.effort')} onSelect={(value) => setAgent({ effort: value })} />
                )}
                <Switch
                    checked={agent?.auto !== false}
                    title={t('settings.models.auto')}
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
                                <div className="banner__title">{t('settings.error.title')}</div>
                                <div className="banner__text banner__text--clamp selectable">{error}</div>
                            </div>
                            <div className="banner__actions">
                                <button className="close-button" title={t('common.action.hide')} onClick={() => setError(null)}>
                                    <Icon id="i-close" />
                                </button>
                            </div>
                        </div>
                    )}
                    <div className="section">
                        <div className="section__header">{t('settings.general.header')}</div>
                        <div className="section__card">
                            <div className="settings-row">
                                <span className="settings-row__title">{t('settings.theme.title')}</span>
                                <div className="segmented segmented--dimension">
                                    {THEMES.map((item) => (
                                        <button
                                            key={item}
                                            className="segmented__item"
                                            aria-selected={theme === item}
                                            onClick={() => {
                                                chooseTheme(item);
                                                setTheme(item);
                                            }}
                                        >
                                            {t(`settings.theme.${item}`)}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div className="row-divider" />
                            <div className="settings-row" title={t('common.language.hint')}>
                                <span className="settings-row__title">{t('common.language.title')}</span>
                                <Select
                                    options={(['system', 'ru', 'en'] as const).map((id) => ({ id, title: t(`common.language.${id}`) }))}
                                    value={language}
                                    width={160}
                                    onSelect={async (id) => {
                                        // Выбор живёт в config.json: если сервис его не сохранил, окно возвращается к прежнему языку, а не расходится с файлом до перезапуска
                                        const previous = language;
                                        setLangSetting(id as LangSetting);
                                        if (api && (await run(() => api.PUT('/settings/language', { body: { language: id as LangSetting } })))) setLangSetting(previous);
                                    }}
                                />
                            </div>
                            <div className="row-divider" />
                            <div className="settings-row" title={t('settings.general.backgroundHint')}>
                                <span className="settings-row__title">{t('settings.general.background')}</span>
                                <Switch checked={!paused} onChange={(on) => api && run(() => api.POST(on ? '/resume' : '/pause'))} />
                            </div>
                            <div className="row-divider" />
                            <div className={`settings-row${paused ? ' settings-row--dim' : ''}`} title={paused ? dim : t('settings.general.intervalHint')}>
                                <span className="settings-row__title">{t('settings.general.interval')}</span>
                                <span className="settings-row__value">{t('common.time.minutes', { minutes: interval })}</span>
                                <Stepper
                                    disabled={paused}
                                    onStep={(direction) => {
                                        const next = stepInterval(interval, direction);
                                        if (next && api) run(() => api.PUT('/settings/interval', { body: { minutes: next } }));
                                    }}
                                />
                            </div>
                            <div className="row-divider" />
                            <NavRow title={t('settings.notifications.title')} value={notificationsValue} color={denied || muted ? 'var(--orange)' : null} onClick={() => setSheet('notifications')} />
                        </div>
                        <div className="section__footer">{footer}</div>
                    </div>
                    <div className="section">
                        <div className="section__header">{t('settings.repos.header')}</div>
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
                                <span className="settings-row__title">{t('settings.repos.add')}</span>
                            </button>
                        </div>
                    </div>
                    <div className="section">
                        <div className="section__header">{t('settings.models.header')}</div>
                        <div className="section__card">
                            {agentIds(config).map((id, index) => (
                                <Fragment key={id}>
                                    {index > 0 && <div className="row-divider row-divider--tile" />}
                                    {agentRow(id)}
                                </Fragment>
                            ))}
                        </div>
                        <div className="section__footer">{t('settings.models.footer')}</div>
                    </div>
                    <div className="section">
                        <div className="section__header">{t('settings.advanced.header')}</div>
                        <div className="section__card">
                            <NavRow
                                title={t('settings.branches.title')}
                                value={config.branchPattern ?? DEFAULT_BRANCH_PATTERN}
                                mono
                                hint={t('settings.branches.hint')}
                                onClick={() => setSheet('branches')}
                            />
                            <div className="row-divider" />
                            <NavRow title={t('settings.ignore.title')} value={String(config.ignorePaths?.length ?? 0)} onClick={() => setSheet('ignore')} />
                            <div className="row-divider" />
                            <NavRow title={t('settings.tokens.title')} value={tokenValue.text} color={tokenValue.color} hint={t('settings.tokens.hint')} onClick={() => setSheet('tokens')} />
                            <div className="row-divider" />
                            <NavRow title="config.json" onClick={() => setSheet('config')} />
                            <div className="row-divider" />
                            <NavRow title={t('settings.log.title')} value={errorsLastDay(log, now)} color="var(--orange)" hint={t('settings.log.hint', { count: LOG_LIMIT })} onClick={() => setSheet('log')} />
                        </div>
                        <div className="section__footer">{t('settings.advanced.footer')}</div>
                    </div>
                    {build && (
                        <div className="build-info selectable" title={build.hint}>
                            {build.text}
                            {build.dirty && (
                                <>
                                    {' '}
                                    <span className="tag" style={{ '--tag-color': 'var(--orange)' } as CSSProperties}>
                                        {t('settings.build.dirty')}
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
                        if (!api) return t('settings.error.noService');
                        const { data: added, error: failure } = await api.POST('/repos', { body: { ref } });
                        if (failure) return errorText(failure);
                        // Как addRepo в SwiftUI: служебная копия скачивается сразу, без «Скачать»
                        const slug = (added as { slug?: string } | undefined)?.slug;
                        if (slug) clone(slug);
                        else loadClones();
                        return null;
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
            {sheet === 'config' && api && <ConfigSheet api={api} config={config} canOpenInCode={canOpenInCode} onOpenInCode={(path) => invoke('open_in_code', { path }).catch((reason) => setError(String(reason)))} onClose={() => setSheet(null)} />}
        </>
    );
};
