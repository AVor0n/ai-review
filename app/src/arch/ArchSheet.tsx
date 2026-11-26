import { openUrl } from '@tauri-apps/plugin-opener';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { errorText, type ApiClient } from '../api/client';
import { CommandError } from '../components/CommandError';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { t } from '../i18n';
import { agentName, archOf, isArchStale } from '../model/derive';
import { formatDate, parse } from '../model/format';
import { middle } from '../model/middle';
import type { Data, PullRequest } from '../model/types';
import { exportParts } from '../stats/exportImage';

// Лист «Архитектурное ревью» — перенос ArchReportSheet из menubar/ArchViews.swift.
// Разметка — шаблоны tpl-arch-* и tpl-sheet-* макета 2026-11-26-tauri-arch.html
type Place = { level?: string | null; title: string; details: string; path: string; line: number };
type Report = {
    goal: string;
    goalClarity: string;
    approach: string;
    alternatives: { title: string; idea: string; pros: string[]; cons: string[]; switchCost: string; better: boolean }[];
    simpler: Place[];
    risks: Place[];
    verdict: string;
    summary: string;
    questions: string[];
};
type Result = { report: Report; head: string; agent: string; model?: string | null; usage?: { costUsd?: number | null } | null; durationSec?: number | null };
type Arch = { state: string; activity?: string | null; error?: string | null; startedAt?: string | null; finishedAt?: string | null; result?: Result | null };

const VERDICTS: Record<string, [string, string]> = {
    keep: ['i-verdict-keep', 'var(--green)'],
    discuss: ['i-verdict-discuss', 'var(--yellow)'],
    rework: ['i-verdict-rework', 'var(--orange)'],
};
const verdictOf = (value: string): [string, string, string] =>
    value === 'keep' || value === 'discuss' || value === 'rework' ? [t(`reports.arch.verdict.${value}`), ...VERDICTS[value]] : [value, 'i-verdict-discuss', 'var(--label-2)'];
const clarity = (value: string) => (value === 'stated' || value === 'inferred' || value === 'unclear' ? t(`reports.arch.clarity.${value}`) : value);
const switchCost = (value: string) => (value === 'low' || value === 'medium' || value === 'high' ? t(`reports.arch.switchCost.${value}`) : value);
// Ширина строки пути и активности в символах моноширинного 11 px на листе 660
const LOCATION_CHARS = 80;
const ACTIVITY_CHARS = 84;
const SHEET_WIDTH = 660;
const SHEET_PADDING = 20;

const duration = (seconds: number) => {
    const total = Math.max(0, Math.floor(seconds));
    return total < 60 ? t('common.time.seconds', { seconds: total }) : t('common.time.minutesSeconds', { minutes: Math.floor(total / 60), seconds: total % 60 });
};

const location = (place: Place) => (place.path ? (place.line > 0 ? `${place.path}:${place.line}` : place.path) : null);

const tone = (color: string) => ({ '--c': color }) as CSSProperties;

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
    <div className="section">
        <div className="section__header">{title}</div>
        <div className="section__card">{children}</div>
    </div>
);

const Rows = ({ items, divider = 'row-divider' }: { items: ReactNode[]; divider?: string }) => (
    <>
        {items.map((item, index) => (
            <div key={index}>
                {index > 0 && <div className={divider} />}
                {item}
            </div>
        ))}
    </>
);

const PlaceRow = ({ place, marker }: { place: Place; marker: ReactNode }) => {
    const where = location(place);
    return (
        <div className="place md">
            <span className="place__marker">{marker}</span>
            <div className="place__body selectable">
                <span className="place__title">
                    <Markdown text={place.title} />
                </span>
                {where && (
                    <span className="place__location" title={where}>
                        {middle(where, LOCATION_CHARS)}
                    </span>
                )}
                <span>
                    <Markdown text={place.details} />
                </span>
            </div>
        </div>
    );
};

const ReportView = ({ result, finishedAt, name }: { result: Result; finishedAt: string | null | undefined; name: (id: string) => string }) => {
    const { report } = result;
    const finished = parse(finishedAt);
    const details = [
        [t('reports.arch.model'), `${name(result.agent)}${result.model ? ` · ${result.model}` : ''}`],
        [t('reports.arch.commit'), result.head],
        [t('reports.arch.finishedAt'), finished ? formatDate(finished, { dateStyle: 'medium', timeStyle: 'short' }) : ''],
        [t('reports.sheet.costAndTime'), [result.usage?.costUsd != null ? `$${result.usage.costUsd.toFixed(2)}` : null, result.durationSec != null ? duration(result.durationSec) : null].filter(Boolean).join(' · ')],
    ].filter(([, value]) => value);
    return (
        <>
            <Section title={t('reports.arch.summary')}>
                <div className="report-paragraph md">
                    <Markdown text={report.summary} />
                </div>
            </Section>
            <Section title={t('reports.arch.goal', { clarity: clarity(report.goalClarity) })}>
                <div className="report-paragraph md">
                    <Markdown text={report.goal} />
                </div>
            </Section>
            <Section title={t('reports.arch.approach')}>
                <div className="report-paragraph md">
                    <Markdown text={report.approach} />
                </div>
            </Section>
            {report.alternatives.length > 0 && (
                <Section title={t('reports.arch.alternatives', { count: report.alternatives.length })}>
                    <Rows
                        items={report.alternatives.map((alternative, index) => (
                            <div key={index} className="alternative md selectable">
                                <div className="alternative__head">
                                    <span className="alternative__title">
                                        <Markdown text={alternative.title} />
                                    </span>
                                    {alternative.better && <span className="tag tag--green">{t('reports.arch.better')}</span>}
                                    <span className="tag">{switchCost(alternative.switchCost)}</span>
                                </div>
                                <div>
                                    <Markdown text={alternative.idea} />
                                </div>
                                {alternative.pros.map((pro, line) => (
                                    <div key={`p${line}`} className="bullet" style={tone('var(--green)')}>
                                        <Icon id="i-plus-circle-fill" />
                                        <span>
                                            <Markdown text={pro} />
                                        </span>
                                    </div>
                                ))}
                                {alternative.cons.map((con, line) => (
                                    <div key={`c${line}`} className="bullet" style={tone('var(--orange)')}>
                                        <Icon id="i-minus-circle-fill" />
                                        <span>
                                            <Markdown text={con} />
                                        </span>
                                    </div>
                                ))}
                            </div>
                        ))}
                    />
                </Section>
            )}
            {report.simpler.length > 0 && (
                <Section title={t('reports.arch.simpler', { count: report.simpler.length })}>
                    <Rows
                        divider="row-divider row-divider--marker"
                        items={report.simpler.map((place, index) => (
                            <PlaceRow
                                key={index}
                                place={place}
                                marker={
                                    <span style={tone('var(--accent)')}>
                                        <Icon id="i-scissors" />
                                    </span>
                                }
                            />
                        ))}
                    />
                </Section>
            )}
            {report.risks.length > 0 && (
                <Section title={t('reports.arch.risks', { count: report.risks.length })}>
                    <Rows
                        divider="row-divider row-divider--tag"
                        items={report.risks.map((place, index) => (
                            <PlaceRow key={index} place={place} marker={<span className={`tag ${place.level === 'P0' ? 'tag--red' : 'tag--orange'}`}>{place.level ?? 'P1'}</span>} />
                        ))}
                    />
                </Section>
            )}
            {report.questions.length > 0 && (
                <Section title={t('reports.arch.questions', { count: report.questions.length })}>
                    <Rows
                        divider="row-divider row-divider--marker"
                        items={report.questions.map((question, index) => (
                            <div key={index} className="place md">
                                <span className="place__marker">
                                    <Icon id="i-question" />
                                </span>
                                <div className="place__body selectable">
                                    <span>
                                        <Markdown text={question} />
                                    </span>
                                </div>
                            </div>
                        ))}
                    />
                </Section>
            )}
            <Section title={t('reports.sheet.details')}>
                <Rows
                    items={details.map(([title, value]) => (
                        <div key={title} className="detail-row">
                            <span className="detail-row__title">{title}</span>
                            <span className="detail-row__value selectable">{value}</span>
                        </div>
                    ))}
                />
            </Section>
        </>
    );
};

export const ArchSheet = ({ api, data, repo, prId, onRerun, onClose }: { api: ApiClient; data: Data; repo: string; prId: number; onRerun: (pr: PullRequest) => void; onClose: () => void }) => {
    // Снимок PR обновляется, пока лист открыт: устаревание отчёта сверяем со свежей головой
    const pr = data.snapshots[repo]?.prs.find((item) => item.id === prId);
    const arch = archOf(data, repo, prId) as Arch | null;
    const [now, setNow] = useState(Date.now());
    const [copied, setCopied] = useState(false);
    const [saving, setSaving] = useState(false);
    // В картинку — только заголовок и название PR, без кнопки закрытия
    const head = useRef<HTMLDivElement>(null);
    const [commandError, setCommandError] = useState<string | null>(null);
    const body = useRef<HTMLDivElement>(null);
    const name = (id: string) => agentName(data.config, id);

    useEffect(() => {
        if (arch?.state !== 'running') return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [arch?.state]);

    if (!pr) return null;
    const result = arch?.result ?? null;
    const active = arch?.state === 'queued' || arch?.state === 'running';
    const stale = !!arch && isArchStale(arch as never, pr);

    const copyMarkdown = async () => {
        const { data: answer, error } = await api.GET('/arch/{repo}/{pr}/markdown', { params: { path: { repo, pr: prId } } });
        const text = (answer as { output?: string } | undefined)?.output;
        if (error || !text) return setCommandError(error ? errorText(error) : t('reports.arch.emptyReport'));
        try {
            await navigator.clipboard.writeText(text);
        } catch (failure) {
            return setCommandError(t('reports.arch.copyFailed', { error: String(failure) }));
        }
        setCommandError(null);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // Шапка и весь отчёт без прокрутки, без строки статуса, баннеров и кнопок — ширина как у листа
    const saveImage = async () => {
        if (!head.current || !body.current || saving) return;
        setSaving(true);
        const sections = ([...body.current.children] as HTMLElement[]).filter((part) => !part.dataset.skipExport);
        await exportParts([head.current, ...sections], `pr-reviewer-arch-${repo}-${prId}`, { width: SHEET_WIDTH, padding: SHEET_PADDING, gap: parseFloat(getComputedStyle(body.current).rowGap) || 0 })
            .then(() => setCommandError(null))
            .catch((failure) => setCommandError(t('reports.arch.saveImageFailed', { error: String(failure) })));
        setSaving(false);
    };

    const started = parse(arch?.startedAt);
    const verdict = verdictOf(result?.report.verdict ?? '');
    const status = !arch ? null : arch.state === 'queued' ? (
        <span className="report-status">
            <Icon id="i-clock" />
            <span className="report-status__text" style={{ color: 'var(--label-2)' }}>
                {result ? t('reports.arch.queuedWithPrevious') : t('reports.sheet.queued')}
            </span>
        </span>
    ) : arch.state === 'running' ? (
        <span className="report-status" style={tone('var(--blue)')}>
            <Icon id="i-hourglass" className="icon hourglass" />
            <span className="report-status__text">
                {started
                    ? t(result ? 'reports.arch.runningForWithPrevious' : 'reports.arch.runningFor', { time: duration((now - started.getTime()) / 1000) })
                    : t(result ? 'reports.arch.runningWithPrevious' : 'reports.arch.running')}
                {arch.activity && (
                    <span className="report-status__activity" title={arch.activity}>
                        {middle(arch.activity, ACTIVITY_CHARS)}
                    </span>
                )}
            </span>
        </span>
    ) : arch.state === 'done' ? (
        <span className="report-status" style={tone(verdict[2])}>
            <Icon id={verdict[1]} />
            <span className="report-status__text" style={{ color: 'var(--label)' }}>
                {verdict[0]}
            </span>
        </span>
    ) : (
        <span className="report-status" style={tone('var(--orange)')}>
            <Icon id="i-warning-fill" />
            <span className="report-status__text selectable">{arch.error?.split('\n').filter(Boolean).pop() ?? t('reports.sheet.failed')}</span>
        </span>
    );

    const rerun = () => {
        onClose();
        onRerun(pr);
    };

    return (
        <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()} onKeyDown={(event) => event.key === 'Escape' && onClose()}>
            <div className="sheet sheet--wide sheet--tall" role="dialog" aria-label={t('reports.arch.title', { pr: pr.id })}>
                <div className="sheet__head">
                    <div className="sheet__titles" ref={head}>
                        <div className="sheet__title">{t('reports.arch.title', { pr: pr.id })}</div>
                        <div className="sheet__subtitle sheet__subtitle--line">{pr.title}</div>
                    </div>
                    <button className="round-button round-button--close" title={t('common.action.close')} onClick={onClose}>
                        <Icon id="i-close" />
                    </button>
                </div>
                {status}
                {commandError && <CommandError text={commandError} onClose={() => setCommandError(null)} />}
                {result && !active && stale && (
                    <div className="banner banner--warning">
                        <Icon id="i-history" className="icon banner__icon" />
                        <div className="banner__body">
                            <div className="banner__title">{t('reports.arch.staleTitle')}</div>
                            <div className="banner__text">
                                {t('reports.arch.staleText', { head: result.head, prHead: pr.head })}
                            </div>
                        </div>
                    </div>
                )}
                <div className="sheet__body" ref={body}>
                    {!arch && <div className="section__empty">{t('reports.arch.empty')}</div>}
                    {arch?.state === 'failed' && arch.error?.includes('\n') && (
                        <div className="section" data-skip-export="true">
                            <div className="section__header">{t('reports.sheet.output')}</div>
                            <div className="section__card">
                                <div className="output selectable">{arch.error}</div>
                            </div>
                        </div>
                    )}
                    {result && <ReportView result={result} finishedAt={arch?.finishedAt} name={name} />}
                </div>
                <div className="sheet__footer">
                    <button className="button" onClick={() => openUrl(pr.url).catch(() => {})}>
                        {t('reports.sheet.openPr')}
                    </button>
                    <button className="button" disabled={!result} onClick={copyMarkdown}>
                        {copied ? t('reports.arch.copied') : t('reports.arch.copyMarkdown')}
                    </button>
                    <button className="square-button" title={t('reports.arch.saveImage')} disabled={!result || saving} style={result ? undefined : { opacity: 0.4 }} onClick={saveImage}>
                        <Icon id={saving ? 'i-spinner' : 'i-camera'} />
                    </button>
                    <span className="spacer" />
                    {active ? (
                        <button className="button button--destructive" onClick={() => api.POST('/arch/{repo}/{pr}/stop', { params: { path: { repo, pr: prId } } })}>
                            {t('reports.sheet.stop')}
                        </button>
                    ) : stale ? (
                        <button className="button button--prominent" autoFocus onClick={rerun}>
                            {t('reports.arch.restart')}
                        </button>
                    ) : (
                        <button className="button" onClick={rerun}>
                            {arch ? t('reports.sheet.runAgain') : t('reports.arch.start')}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};
