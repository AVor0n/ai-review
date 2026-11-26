import { Fragment } from 'react';
import type { Banner, BannerAction } from '../model/banners';
import { agentName, headline, isPaused, isRunning, runningReviews } from '../model/derive';
import { ago, roleName, shortRepoName } from '../model/format';
import { capsules, sortedPrs } from '../model/row';
import type { Data } from '../model/types';
import { Banners } from './Banners';
import { Icon } from './Icon';
import { PrRow, type RowHandlers } from './PrRow';
import { t } from '../i18n';

export type OverviewHandlers = RowHandlers & {
    command: (path: '/run-now' | '/stop' | '/resume' | '/sync') => void;
    toggleRepo: (slug: string) => void;
    banner: (action: BannerAction) => void;
    closeBanner: (close: NonNullable<Banner['close']>) => void;
    toggleBanners: () => void;
};

export type OverviewState = {
    // Нет связи с сервисом: шапка «Сервис не отвечает», данные — последние полученные
    offline: boolean;
    data: Data | null;
    banners: Banner[];
    bannersExpanded: boolean;
    collapsed: string[];
    syncing: boolean;
    now: Date;
};

const StatusBar = ({ state, on }: { state: OverviewState; on: OverviewHandlers }) => {
    const { data, now } = state;
    if (state.offline || !data?.status)
        return (
            <div className="status-bar">
                <span className="status-dot status-dot--offline" />
                <span className="status-text">{state.offline ? t('overview.status.offline') : t('overview.status.connecting')}</span>
            </div>
        );
    const running = isRunning(data.status);
    const paused = isPaused(data.status);
    const reviews = runningReviews(data.status);
    return (
        <div className="status-bar">
            <span className={`status-dot${running ? ' status-dot--running' : paused ? ' status-dot--paused' : ''}`} />
            {reviews.length > 1 ? (
                // Несколько ревью — по значку модели и номеру PR в одной строке; полный список — в подсказке
                <span
                    className="status-text"
                    title={reviews
                        .map((review) =>
                            t(review.title ? 'overview.status.reviewHintTitled' : 'overview.status.reviewHint', {
                                repo: shortRepoName(review.repo, data.config.displayPrefix),
                                pr: review.pr,
                                title: review.title ?? '',
                                model: agentName(data.config, review.agent),
                                role: roleName(review.role),
                            }),
                        )
                        .join('\n')}
                >
                    {t('overview.status.reviews')}&nbsp;
                    {reviews.map((review, index) => (
                        <Fragment key={`${review.repo}#${review.pr}#${review.agent}`}>
                            {index > 0 && <span className="status-text__sep"> · </span>}
                            <span className={`model-mark model--${review.agent} status-text__mark`} />
                            {shortRepoName(review.repo, data.config.displayPrefix)} #{review.pr}
                        </Fragment>
                    ))}
                </span>
            ) : (
                // Полный текст паузы не помещается рядом с кнопкой «Включить» и капсулами
                <span className="status-text" title={paused && !running ? t('overview.status.pausedHint') : undefined}>
                    {headline(data, now)}
                </span>
            )}
            {paused && !running && (
                <button className="link-button" onClick={() => on.command('/resume')}>
                    {t('overview.status.resume')}
                </button>
            )}
            <span className="spacer" />
            {capsules(data, now).map((capsule) => (
                <button key={capsule.agent} className={`capsule${capsule.limited ? ' capsule--limit' : ''} model--${capsule.agent}`} title={capsule.hint} onClick={() => on.settings(null)}>
                    <span className="model-button">
                        <span className="model-mark" />
                        <span className={`model-badge model-badge--${capsule.limited ? 'limit' : 'manual'}`}>
                            <Icon id={capsule.limited ? 'i-badge-hourglass' : 'i-badge-pause'} />
                        </span>
                    </span>
                    {capsule.text}
                </button>
            ))}
            {running ? (
                <button className="icon-button" title={reviews.length > 1 ? t('overview.status.stopAll') : t('overview.status.stop')} onClick={() => on.command('/stop')}>
                    <Icon id="i-stop" />
                </button>
            ) : (
                !paused && (
                    <button className="icon-button" title={t('overview.status.runNow')} onClick={() => on.command('/run-now')}>
                        <Icon id="i-play" />
                    </button>
                )
            )}
            {state.syncing ? (
                <button className="icon-button" disabled title={t('overview.status.syncing')}>
                    <Icon id="i-spinner" />
                </button>
            ) : (
                <button className="icon-button" title={t('overview.status.sync')} onClick={() => on.command('/sync')}>
                    <Icon id="i-refresh" className="icon icon--14" />
                </button>
            )}
        </div>
    );
};

const Repos = ({ state, on }: { state: OverviewState; on: OverviewHandlers }) => {
    const data = state.data!;
    return (
        <div className="scroll">
            <div className="sections">
                {data.config.repos.map((repo) => {
                    const snapshot = data.snapshots[repo.slug];
                    const expanded = !state.collapsed.includes(repo.slug);
                    const prs = snapshot ? sortedPrs(snapshot.prs) : [];
                    return (
                        <section key={repo.slug} className={`section${expanded ? ' section--expanded' : ''}`}>
                            <button className="section__header" onClick={() => on.toggleRepo(repo.slug)}>
                                <Icon id="i-chevron-right" className="icon section__chevron" />
                                <span>{repo.slug}</span>
                                {snapshot && <span>· {snapshot.prs.length}</span>}
                                {/* При выключенном общем фоновом ревью об этом уже говорит шапка обзора */}
                                {repo.paused && !isPaused(data.status) && (
                                    <span className="section__plain" style={{ display: 'flex', alignItems: 'center', gap: 4 }} title={t('overview.repo.pausedHint')}>
                                        {/* Разметка и стили — как в шаблоне tpl-repos макета */}
                                        <Icon id="i-pause-fill" style={{ color: 'var(--orange)' }} />
                                        {t('overview.repo.paused')}
                                    </span>
                                )}
                                <span className="spacer" />
                                {snapshot && <span className="section__plain">{t('overview.repo.updated', { time: ago(snapshot.fetchedAt, state.now) })}</span>}
                            </button>
                            {expanded && (
                                <div className="section__card">
                                    {prs.length ? (
                                        prs.map((pr, index) => (
                                            <Fragment key={pr.id}>
                                                {index > 0 && <div className="row-divider row-divider--pr" />}
                                                <PrRow data={data} repo={repo.slug} pr={pr} now={state.now} on={on} />
                                            </Fragment>
                                        ))
                                    ) : (
                                        <div className="section__empty">{t(snapshot ? 'overview.repo.empty' : state.syncing ? 'overview.repo.loading' : 'overview.repo.notLoaded')}</div>
                                    )}
                                </div>
                            )}
                        </section>
                    );
                })}
            </div>
        </div>
    );
};

export const Overview = ({ state, on }: { state: OverviewState; on: OverviewHandlers }) => {
    const { data } = state;
    const hasData = !!data?.status;
    return (
        <div className="screen">
            <StatusBar state={state} on={on} />
            <Banners items={state.banners} expanded={state.bannersExpanded} onToggle={on.toggleBanners} onAction={on.banner} onClose={on.closeBanner} />
            {!hasData && state.offline && (
                <div className="empty-state">
                    <Icon id="i-tray" className="icon empty-state__icon" />
                    <div className="empty-state__title">{t('overview.empty.noDataTitle')}</div>
                    <div className="empty-state__text">{t('overview.empty.noDataText')}</div>
                </div>
            )}
            {hasData &&
                (data!.config.repos.length ? (
                    <Repos state={state} on={on} />
                ) : (
                    <div className="empty-state">
                        <Icon id="i-tray" className="icon empty-state__icon" />
                        <div className="empty-state__title">{t('overview.empty.noReposTitle')}</div>
                        <div className="empty-state__text">{t('overview.empty.noReposText')}</div>
                        <button className="button" onClick={() => on.settings('add-repo')}>
                            {t('overview.empty.connect')}
                        </button>
                    </div>
                ))}
        </div>
    );
};
