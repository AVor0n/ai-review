import { confirm } from '../dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Fragment, useCallback, useEffect, useState, type CSSProperties } from 'react';
import { errorText, type ApiClient } from '../api/client';
import { Icon } from '../components/Icon';
import { t, tx } from '../i18n';
import { Markdown } from '../components/Markdown';
import { agentName } from '../model/derive';
import { ago, parse, shortDate } from '../model/format';
import { middle } from '../model/middle';
import type { Data } from '../model/types';
import {
    closeReason,
    fileUrl,
    groups,
    isOpen,
    isStale,
    isStaleVerdict,
    jobTitle,
    lastScan,
    likelihoodTitle,
    location,
    prSources,
    sourceKind,
    triageHeading,
    triageIcon,
    triageTitle,
    type BacklogItem,
    type BacklogJob,
    type BacklogScan,
    type BacklogSource,
} from './model';

// Вкладка «Бэклог» — перенос BacklogView и BacklogRow из menubar/BacklogView.swift.
// Разметка — шаблоны tpl-backlog*, tpl-row-* и tpl-toolbar-waiting макета 2026-11-26-tauri-backlog.html
type Edit = { id: string; action: 'filed' | 'drop' };
type Result = { error?: unknown };

const SHOW_ALL_KEY = 'pr-reviewer.backlogShowAll';
const JOB_SEEN_KEY = 'pr-reviewer.backlogJobSeen';
const ACTIVITY_CHARS = 90;

const stored = (key: string) => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};
const store = (key: string, value: string) => {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Без хранилища выбор живёт до перезапуска
    }
};

const tagColor = (color: string) => ({ '--tag-color': color }) as CSSProperties;

export const BacklogScreen = ({ api, data, version }: { api: ApiClient | null; data: Data; version: number }) => {
    const [items, setItems] = useState<BacklogItem[] | null>(null);
    const [job, setJob] = useState<BacklogJob | null>(null);
    const [scan, setScan] = useState<BacklogScan | null>(null);
    const [showAll, setShowAll] = useState(() => stored(SHOW_ALL_KEY) === 'true');
    const [jobSeen, setJobSeen] = useState(() => stored(JOB_SEEN_KEY) ?? '');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<Set<string>>(new Set());
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [editing, setEditing] = useState<Edit | null>(null);
    const [draft, setDraft] = useState('');
    const [copied, setCopied] = useState(false);

    const load = useCallback(async () => {
        if (!api) return;
        const [backlog, jobs] = await Promise.all([api.GET('/backlog'), api.GET('/backlog/job')]);
        if (backlog.data) setItems(((backlog.data as { items?: BacklogItem[] }).items ?? []) as BacklogItem[]);
        if (jobs.data) {
            setJob((jobs.data.job ?? null) as BacklogJob | null);
            setScan((jobs.data.scan ?? null) as BacklogScan | null);
        }
    }, [api]);

    // Сервис присылает событие backlog на любое изменение backlog*.json — версия растёт вместе со статистикой
    useEffect(() => {
        load();
    }, [load, version]);

    const run = async (request: () => Promise<Result>) => {
        const { error: failure } = await request();
        setError(failure ? errorText(failure) : null);
        await load();
        return !failure;
    };

    const all = items ?? [];
    const waiting = all.filter(isOpen).length;
    const stale = all.filter(isStale);
    const shown = groups(all, showAll, data.config.repos.map((repo) => repo.slug));
    const empty = !shown.length;
    const running = job?.running === true;
    const finished = job && !running ? (job.finishedAt ?? job.startedAt) : null;

    const setStatus = async (id: string, action: 'filed' | 'drop' | 'reopen', text = '') => {
        if (!api) return;
        setBusy((current) => new Set([...current, id]));
        await run(() => api.POST('/backlog/{id}/{action}', { params: { path: { id, action } }, body: { text } }));
        setBusy((current) => new Set([...current].filter((value) => value !== id)));
    };

    const closeStale = async () => {
        if (!api) return;
        setBusy(new Set(stale.map((item) => item.id)));
        await run(() => api.POST('/backlog/close-stale'));
        setBusy(new Set());
    };

    const startJob = (kind: 'triage' | 'learn') => api && run(() => api.POST('/backlog/jobs', { body: { kind } }));

    const confirmTriage = async () => {
        const confirmed = await confirm(t('backlog.triageConfirm.body'), {
            title: t('backlog.triageConfirm.title', { count: waiting }),
            kind: 'info',
            okLabel: t('backlog.triageConfirm.ok'),
            cancelLabel: t('common.action.cancel'),
        });
        if (confirmed) startJob('triage');
    };

    const copy = async () => {
        if (!api) return;
        const { data: answer, error: failure } = await api.GET('/backlog/markdown', { params: { query: { all: showAll } } });
        const text = (answer as { output?: string } | undefined)?.output;
        if (failure || text == null) return setError(failure ? errorText(failure) : t('backlog.errors.noMarkdown'));
        try {
            await navigator.clipboard.writeText(text);
        } catch (reason) {
            return setError(t('backlog.errors.clipboard', { reason: String(reason) }));
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    const choose = (value: boolean) => {
        setShowAll(value);
        store(SHOW_ALL_KEY, String(value));
    };

    const seeJob = (value: string) => {
        setJobSeen(value);
        store(JOB_SEEN_KEY, value);
    };

    const startEdit = (id: string, action: Edit['action']) => {
        setDraft('');
        setEditing({ id, action });
    };

    const submit = () => {
        if (!editing) return;
        setStatus(editing.id, editing.action, draft.trim());
        setEditing(null);
    };

    const toggle = (id: string) => setExpanded((current) => (current.has(id) ? new Set([...current].filter((value) => value !== id)) : new Set([...current, id])));
    const sourceName = (source: BacklogSource) => (source.agent === 'human' ? (source.author ?? t('backlog.row.team')) : agentName(data.config, source.agent));
    const agents = (item: BacklogItem) => [...new Set(item.sources.map(sourceName))].join(', ');

    const row = (item: BacklogItem) => {
        const open = expanded.has(item.id);
        const edit = editing?.id === item.id ? editing : null;
        const url = fileUrl(item, data.config);
        const where = location(item);
        const likelihood = likelihoodTitle(item);
        return (
            <div className={`backlog-row${open ? ' backlog-row--expanded' : ''}${isOpen(item) ? '' : ' backlog-row--closed'}`}>
                <div className="backlog-row__top">
                    <button className="backlog-row__toggle" title={open ? t('backlog.row.collapse') : t('backlog.row.expand')} onClick={() => toggle(item.id)}>
                        <Icon id="i-chevron-right" className="icon backlog-row__chevron" />
                        <span className="backlog-row__level">
                            <span className="tag" style={tagColor(`var(--level-${item.level.toLowerCase()})`)}>
                                {item.level}
                            </span>
                        </span>
                        <span className="backlog-row__title">{item.title}</span>
                    </button>
                    <span className="backlog-row__actions">
                        {busy.has(item.id) ? (
                            <Icon id="i-spinner" />
                        ) : isOpen(item) ? (
                            <>
                                <button className="link-button" title={t('backlog.row.fileHint')} onClick={() => startEdit(item.id, 'filed')}>
                                    {t('backlog.row.filed')}
                                </button>
                                {item.triage && isStale(item) ? (
                                    <button className="link-button link-button--secondary" title={t('backlog.row.closeHint')} onClick={() => setStatus(item.id, 'drop', closeReason(item.triage!))}>
                                        {t('backlog.row.close')}
                                    </button>
                                ) : (
                                    <button className="link-button link-button--secondary" title={t('backlog.row.dropHint')} onClick={() => startEdit(item.id, 'drop')}>
                                        {t('backlog.row.drop')}
                                    </button>
                                )}
                            </>
                        ) : (
                            <>
                                {item.status === 'filed' ? (
                                    <span className="tag" style={tagColor('var(--fate-addressed)')}>
                                        {item.ticket ? t('backlog.row.ticket', { ticket: item.ticket }) : t('backlog.row.filed')}
                                    </span>
                                ) : (
                                    <span className="tag">{t('backlog.row.dropped')}</span>
                                )}
                                <button className="link-button" title={t('backlog.row.reopenHint')} onClick={() => setStatus(item.id, 'reopen')}>
                                    {t('backlog.row.reopen')}
                                </button>
                            </>
                        )}
                    </span>
                </div>
                <div className="backlog-row__meta">
                    {tx('backlog.row.foundIn', {
                        prs: prSources(item).map((source) => (
                            <button key={source.pr} className="link-button" title={t('backlog.row.openPr')} onClick={() => openUrl(source.url).catch(() => {})}>
                                #{source.pr}
                            </button>
                        )),
                    })}{' '}
                    · {agents(item)}
                    {likelihood && (
                        <>
                            {' '}
                            <span className="tag">{likelihood}</span>
                        </>
                    )}
                    {/* «Актуально» не показываем: запись в «Ждут разбора» и так считается актуальной */}
                    {item.triage && isOpen(item) && item.triage.verdict !== 'actual' && (
                        <>
                            {' '}
                            <span className="tag" style={isStaleVerdict(item.triage) ? tagColor('var(--fate-addressed)') : undefined} title={item.triage.reason}>
                                {triageTitle(item.triage)}
                            </span>
                        </>
                    )}
                </div>
                {open && (
                    <div className="backlog-row__details md">
                        {where && (
                            <div className="labeled">
                                <span className="labeled__title">{t('backlog.row.file')}</span>
                                <button className="link-button backlog-row__file" disabled={!url} title={url ? t('backlog.row.fileLinkHint') : where} onClick={() => url && openUrl(url).catch(() => {})}>
                                    {where}
                                </button>
                            </div>
                        )}
                        {item.scenario && (
                            <div className="labeled">
                                <span className="labeled__title">{t('backlog.row.scenario')}</span>
                                <span className="selectable">
                                    <Markdown text={item.scenario} />
                                </span>
                            </div>
                        )}
                        {item.fix && (
                            <div className="labeled">
                                <span className="labeled__title">{t('backlog.row.fix')}</span>
                                <span className="selectable">
                                    <Markdown text={item.fix} />
                                </span>
                            </div>
                        )}
                        {item.status === 'dropped' && item.note && (
                            <div className="labeled">
                                <span className="labeled__title">{t('backlog.row.dropReason')}</span>
                                <span className="selectable">
                                    <Markdown text={item.note} />
                                </span>
                            </div>
                        )}
                        {item.triage && (
                            // Линия и заголовок зелёные, только когда запись можно закрыть; значок дублирует цвет
                            <div className="triage-block" style={{ '--c': isStaleVerdict(item.triage) ? 'var(--fate-addressed)' : 'var(--label-2)' } as CSSProperties}>
                                <div className="triage-block__body">
                                    <span className="triage-block__title">
                                        <Icon id={triageIcon(item.triage)} />
                                        {triageHeading(item.triage)}
                                    </span>
                                    <span className="selectable">
                                        <Markdown text={item.triage.reason} />
                                    </span>
                                </div>
                            </div>
                        )}
                        <div className="labeled">
                            <span className="labeled__title">{t('backlog.row.sources')}</span>
                            {item.sources.map((source, index) => (
                                <span key={index} className="backlog-row__sources">
                                    {[`#${source.pr}`, sourceName(source), sourceKind(source), ago(source.at)].join(' · ')}
                                </span>
                            ))}
                        </div>
                        <span className="backlog-row__id selectable">
                            {t('backlog.row.since', { id: item.id, date: parse(item.createdAt) ? shortDate(parse(item.createdAt)!) : '—' })}
                        </span>
                    </div>
                )}
                {edit && (
                    <div className="inline-editor">
                        <input
                            autoFocus
                            placeholder={edit.action === 'filed' ? t('backlog.row.ticketPlaceholder') : t('backlog.row.reasonPlaceholder')}
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') submit();
                                if (event.key === 'Escape') setEditing(null);
                            }}
                        />
                        <button className="link-button link-button--secondary" onClick={() => setEditing(null)}>
                            {t('common.action.cancel')}
                        </button>
                        <button className={`link-button${edit.action === 'drop' ? ' link-button--destructive' : ''}`} onClick={submit}>
                            {edit.action === 'filed' ? t('common.action.save') : t('backlog.row.drop')}
                        </button>
                    </div>
                )}
            </div>
        );
    };

    const scanNote = waiting === 0 ? lastScan(scan) : null;
    const hasBanners = !!error || running || (!!finished && finished !== jobSeen) || stale.length > 0;

    return (
        <div className="screen">
            <div className="toolbar">
                <div className="segmented" style={{ '--segment-width': '110px' } as CSSProperties}>
                    <button className="segmented__item" aria-selected={!showAll} onClick={() => choose(false)}>
                        {t('backlog.filter.waiting')}
                    </button>
                    <button className="segmented__item" aria-selected={showAll} onClick={() => choose(true)}>
                        {t('backlog.filter.all')}
                    </button>
                </div>
                <span className="spacer" />
                {waiting > 0 && !running && (
                    <button className="link-button link-button--icon" title={t('backlog.toolbar.triageHint')} onClick={confirmTriage}>
                        <Icon id="i-triage" />
                        {t('backlog.toolbar.triage')}
                    </button>
                )}
                <button
                    className="link-button link-button--icon"
                    disabled={empty}
                    title={showAll ? t('backlog.toolbar.copyAllHint') : t('backlog.toolbar.copyWaitingHint')}
                    onClick={copy}
                >
                    <Icon id={copied ? 'i-check' : 'i-copy'} />
                    {copied ? t('backlog.toolbar.copied') : t('backlog.toolbar.copy')}
                </button>
            </div>
            {hasBanners && (
                <div className="banners" style={{ marginBottom: 12 }}>
                    {error && (
                        <div className="banner banner--alert" role="alert">
                            <Icon id="i-warning-fill" className="icon banner__icon" />
                            <div className="banner__body">
                                <div className="banner__title">{t('backlog.errors.title')}</div>
                                <div className="banner__text banner__text--clamp selectable">{error}</div>
                            </div>
                            <div className="banner__actions">
                                <button className="close-button" title={t('common.action.hide')} onClick={() => setError(null)}>
                                    <Icon id="i-close" />
                                </button>
                            </div>
                        </div>
                    )}
                    {job && running && (
                        <div className="banner banner--info" style={{ alignItems: 'center' }}>
                            <Icon id="i-spinner" />
                            <div className="banner__body">
                                <div className="banner__text" style={{ color: 'var(--label-2)', fontSize: 'var(--text-callout)', whiteSpace: 'nowrap' }} title={job.activity ?? undefined}>
                                    {jobTitle(job)} · {middle(job.activity ?? t('backlog.job.starting'), ACTIVITY_CHARS)}
                                </div>
                            </div>
                            <div className="banner__actions">
                                <button className="link-button link-button--destructive" onClick={() => api && run(() => api.POST('/backlog/jobs/stop'))}>
                                    {t('backlog.job.stop')}
                                </button>
                            </div>
                        </div>
                    )}
                    {job && finished && finished !== jobSeen && (
                        <div className={`banner banner--${job.state === 'done' ? 'success' : 'alert'}`}>
                            <Icon id={job.state === 'done' ? 'i-check-circle-fill' : 'i-warning-fill'} className="icon banner__icon" />
                            <div className="banner__body">
                                <div className="banner__title">
                                    {jobTitle(job)} · {ago(finished)}
                                </div>
                                <div className="banner__text banner__text--clamp selectable">{job.state === 'done' ? (job.message ?? '') : (job.error ?? t('backlog.job.stopped'))}</div>
                            </div>
                            <div className="banner__actions">
                                <button className="close-button" title={t('common.action.hide')} onClick={() => seeJob(finished)}>
                                    <Icon id="i-close" />
                                </button>
                            </div>
                        </div>
                    )}
                    {stale.length > 0 && (
                        <div className="banner banner--info">
                            <Icon id="i-triage" className="icon banner__icon" />
                            <div className="banner__body">
                                <div className="banner__title">{t('backlog.stale.title', { count: stale.length })}</div>
                                <div className="banner__text">{t('backlog.stale.body')}</div>
                            </div>
                            <div className="banner__actions">
                                <button className="link-button" onClick={closeStale}>
                                    {t('backlog.stale.closeAll')}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}
            {items === null ? null : empty ? (
                <div className="empty-state">
                    <Icon id={all.length ? 'i-check-circle' : 'i-tray'} className="icon empty-state__icon" />
                    <div className="empty-state__title">{all.length ? t('backlog.empty.done') : t('backlog.empty.none')}</div>
                    <div className="empty-state__text">{t('backlog.empty.body')}</div>
                    {scanNote && <div className="empty-state__note">{scanNote}</div>}
                    {/* Сбор из истории предлагается, только когда разбирать нечего: дальше записи приходят из ревью сами */}
                    {waiting === 0 &&
                        (running && job?.kind === 'learn' ? (
                            <Icon id="i-spinner" />
                        ) : (
                            <button className="button" title={t('backlog.empty.learnHint')} onClick={() => startJob('learn')}>
                                {t('backlog.empty.learn')}
                            </button>
                        ))}
                </div>
            ) : (
                <div className="scroll">
                    <div className="sections">
                        {shown.map((group) => (
                            <div key={group.repo} className="section">
                                <div className="section__header">
                                    {group.repo} <span className="section__plain">· {group.items.length}</span>
                                </div>
                                <div className="section__card">
                                    {group.items.map((item, index) => (
                                        <Fragment key={item.id}>
                                            {index > 0 && <div className="row-divider row-divider--backlog" />}
                                            {row(item)}
                                        </Fragment>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};
