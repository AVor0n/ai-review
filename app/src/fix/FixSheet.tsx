import { openUrl } from '@tauri-apps/plugin-opener';
import type { CSSProperties, ReactNode } from 'react';
import type { ApiClient } from '../api/client';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { Steps, type Step } from '../components/Steps';
import { fixOf, threads } from '../model/derive';
import { middle } from '../model/middle';
import type { Data, PullRequest } from '../model/types';

// Лист «Доработка / Rebase» — перенос FixReportSheet из menubar/FixViews.swift.
// Разметка — шаблоны tpl-fix-*, tpl-sheet-* и tpl-steps-done макета 2026-11-26-tauri-fix.html
type Item = { commentId: number; location: string; summary?: string | null; reason?: string | null };
type Report = {
    message: string;
    seenIds?: number[] | null;
    fixed?: Item[] | null;
    skipped?: Item[] | null;
    notes?: string | null;
    checks?: string | null;
    rebase?: string | null;
    backup?: string | null;
    hook?: string | null;
    resumedFrom?: string | null;
    usage?: { costUsd?: number | null } | null;
    durationSec?: number | null;
};
type Fix = { state: string; step?: string | null; error?: string | null; report?: Report | null; finishedAt?: string | null; steps?: Step[] | null; activity?: string | null; mode?: string | null };
type Thread = { id: number; author?: string | null; text: string; path?: string | null; url?: string | null };

const LOCATION_CHARS = 78;
const tone = (color: string) => ({ '--c': color }) as CSSProperties;

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
    <div className="section">
        <div className="section__header">{title}</div>
        <div className="section__card">{children}</div>
    </div>
);

const Rows = ({ items, divider = 'row-divider row-divider--marker' }: { items: ReactNode[]; divider?: string }) => (
    <>
        {items.map((item, index) => (
            <div key={index}>
                {index > 0 && <div className={divider} />}
                {item}
            </div>
        ))}
    </>
);

// Треды, открытые сейчас, но появившиеся после доработки: её итог уже не закрывает все замечания PR
const newThreads = (fix: Fix, pr: PullRequest): Thread[] => {
    if (fix.state !== 'done' || fix.mode === 'rebase' || !fix.report) return [];
    const seen = new Set(fix.report.seenIds ?? [...(fix.report.fixed ?? []), ...(fix.report.skipped ?? [])].map((item) => item.commentId));
    return ((pr.openRoots ?? []) as Thread[]).filter((thread) => !seen.has(thread.id));
};

export const FixSheet = ({ api, data, repo, prId, onRerun, onClose }: { api: ApiClient; data: Data; repo: string; prId: number; onRerun: (pr: PullRequest, rebase: boolean) => void; onClose: () => void }) => {
    const pr = data.snapshots[repo]?.prs.find((item) => item.id === prId);
    const fix = fixOf(data, repo, prId) as Fix | null;
    if (!pr) return null;
    const rebase = fix?.mode === 'rebase';
    const active = fix?.state === 'queued' || fix?.state === 'running';
    const fresh = fix ? newThreads(fix, pr) : [];
    const report = fix?.report ?? null;
    const lastError = fix?.error?.split('\n').filter(Boolean).pop();

    const status = (() => {
        if (!fix) return null;
        if (fix.state === 'queued')
            return (
                <span className="report-status">
                    <Icon id="i-clock" />
                    <span className="report-status__text" style={{ color: 'var(--label-2)' }}>
                        В очереди
                    </span>
                </span>
            );
        if (fix.state === 'running')
            return (
                <span className="report-status" style={tone('var(--blue)')}>
                    <Icon id="i-hourglass" className="icon hourglass" />
                    <span className="report-status__text selectable">{fix.step ?? 'Идёт доработка'}</span>
                </span>
            );
        // Жёлтый текст на светлом фоне не читается — жёлтым остаётся только значок
        if (fix.state === 'done' && fresh.length)
            return (
                <span className="report-status" style={tone('var(--yellow)')}>
                    <Icon id="i-seal-check-fill" />
                    <span className="report-status__text selectable" style={{ color: 'var(--label)' }}>
                        {report?.message ?? 'Готово'}. После доработки появились новые замечания
                    </span>
                </span>
            );
        if (fix.state === 'done')
            return (
                <span className="report-status" style={tone('var(--green)')}>
                    <Icon id="i-seal-check-fill" />
                    <span className="report-status__text selectable">{report?.message ?? 'Готово'}</span>
                </span>
            );
        return (
            <span className="report-status" style={tone('var(--orange)')}>
                <Icon id="i-warning-fill" />
                <span className="report-status__text selectable">{report?.message ?? lastError ?? 'Не удалось'}</span>
            </span>
        );
    })();

    const details = report
        ? ([
              ['Правки', report.resumedFrom ? `из прошлого запуска (${report.resumedFrom}), Claude не запускался заново` : null],
              ['Rebase', report.rebase],
              ['Проверки', report.checks],
              ['Резервная ветка', report.backup],
              ['Заметки', report.notes || null],
              ['Цена и время', report.usage?.costUsd != null ? `$${report.usage.costUsd.toFixed(2)}${report.durationSec != null ? ` · ${Math.floor(report.durationSec / 60)} мин ${report.durationSec % 60} с` : ''}` : null],
          ].filter(([, value]) => value) as [string, string][])
        : [];

    const items = (title: string, list: Item[] | null | undefined, icon: string, color: string, text: (item: Item) => string | null | undefined) =>
        list?.length ? (
            <Section title={`${title} · ${list.length}`}>
                <Rows
                    items={list.map((item, index) => (
                        <div key={index} className="place md">
                            <span className="place__marker" style={tone(color)}>
                                <Icon id={icon} />
                            </span>
                            <div className="place__body selectable">
                                <span className="place__location" title={item.location}>
                                    {middle(item.location, LOCATION_CHARS)}
                                </span>
                                <span>
                                    <Markdown text={text(item) ?? ''} />
                                </span>
                            </div>
                        </div>
                    ))}
                />
            </Section>
        ) : null;

    // Запускать нечего: у доработки нет открытых тредов, у rebase ветка не отстала от базы
    const nothingToRun = rebase ? (pr.behind ?? 0) === 0 : threads(pr).open === 0;

    return (
        <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()} onKeyDown={(event) => event.key === 'Escape' && onClose()}>
            <div className="sheet sheet--medium sheet--tall" role="dialog" aria-label={`${rebase ? 'Rebase' : 'Доработка'} #${pr.id}`}>
                <div className="sheet__head">
                    <div className="sheet__titles">
                        <div className="sheet__title">
                            {rebase ? 'Rebase' : 'Доработка'} #{pr.id}
                        </div>
                        <div className="sheet__subtitle sheet__subtitle--line">{pr.title}</div>
                    </div>
                    <button className="round-button round-button--close" title="Закрыть" onClick={onClose}>
                        <Icon id="i-close" />
                    </button>
                </div>
                {status}
                <div className="sheet__body">
                    {fix?.steps && fix.steps.length > 0 && <Steps steps={fix.steps} active={active} failed={fix.state === 'failed'} finishedAt={fix.finishedAt} activity={fix.activity} />}
                    {!report && fix?.error?.includes('\n') && (
                        <Section title="Вывод">
                            <div className="output selectable">{fix.error}</div>
                        </Section>
                    )}
                    {report && (
                        <>
                            {fresh.length > 0 && (
                                <Section title={`Новые после доработки · ${fresh.length}`}>
                                    <Rows
                                        items={fresh.map((thread) => {
                                            const where = [thread.author, thread.path].filter(Boolean).join(' · ');
                                            return (
                                                <div key={thread.id} className="place md">
                                                    <span className="place__marker" style={tone('var(--yellow)')}>
                                                        <Icon id="i-bubble-plus-fill" />
                                                    </span>
                                                    <div className="place__body selectable">
                                                        <span className="place__location" title={where}>
                                                            {middle(where, LOCATION_CHARS - 6)}
                                                        </span>
                                                        <span>
                                                            <Markdown text={thread.text} />
                                                        </span>
                                                    </div>
                                                    {thread.url && (
                                                        <button className="icon-button place__trail" title="Открыть тред в Bitbucket" onClick={() => openUrl(thread.url!).catch(() => {})}>
                                                            <Icon id="i-open-thread" />
                                                        </button>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    />
                                </Section>
                            )}
                            {items('Исправлено', report.fixed, 'i-check-circle-fill', 'var(--green)', (item) => item.summary)}
                            {items('Не исправлено', report.skipped, 'i-minus-circle-fill', 'var(--orange)', (item) => item.reason)}
                            {details.length > 0 && (
                                <Section title="Подробности">
                                    <Rows
                                        divider="row-divider"
                                        items={details.map(([title, value]) => (
                                            <div key={title} className="detail-row">
                                                <span className="detail-row__title">{title}</span>
                                                <span className="detail-row__value selectable">{value}</span>
                                            </div>
                                        ))}
                                    />
                                </Section>
                            )}
                            {report.hook && (
                                <Section title="Вывод команд">
                                    <div className="output selectable">{report.hook}</div>
                                </Section>
                            )}
                        </>
                    )}
                </div>
                <div className="sheet__footer">
                    <button className="button" onClick={() => openUrl(pr.url).catch(() => {})}>
                        Открыть PR
                    </button>
                    <span className="spacer" />
                    {active ? (
                        <button className="button button--destructive" onClick={() => api.POST('/fixes/{repo}/{pr}/stop', { params: { path: { repo, pr: prId } } })}>
                            Прервать
                        </button>
                    ) : (
                        <button
                            className="button"
                            disabled={nothingToRun}
                            onClick={() => {
                                onClose();
                                onRerun(pr, rebase);
                            }}
                        >
                            Запустить снова
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};
