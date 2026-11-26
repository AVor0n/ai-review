import { openUrl } from '@tauri-apps/plugin-opener';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { errorText, type ApiClient } from '../api/client';
import { CommandError } from '../components/CommandError';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { agentName, archOf, isArchStale } from '../model/derive';
import { parse } from '../model/format';
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

const VERDICTS: Record<string, [string, string, string]> = {
    keep: ['Оставить как есть', 'i-verdict-keep', 'var(--green)'],
    discuss: ['Стоит обсудить', 'i-verdict-discuss', 'var(--yellow)'],
    rework: ['Лучше переделать', 'i-verdict-rework', 'var(--orange)'],
};
const CLARITY: Record<string, string> = { stated: 'описана автором', inferred: 'восстановлена по коду', unclear: 'непонятна' };
const SWITCH_COST: Record<string, string> = { low: 'переделка — часы', medium: 'переделка — день-два', high: 'переделка — больше двух дней' };
// Ширина строки пути и активности в символах моноширинного 11 px на листе 660
const LOCATION_CHARS = 80;
const ACTIVITY_CHARS = 84;
const SHEET_WIDTH = 660;
const SHEET_PADDING = 20;

const duration = (seconds: number) => {
    const total = Math.max(0, Math.floor(seconds));
    return total < 60 ? `${total} с` : `${Math.floor(total / 60)} мин ${total % 60} с`;
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
        ['Модель', `${name(result.agent)}${result.model ? ` · ${result.model}` : ''}`],
        ['Коммит', result.head],
        ['Снят', finished ? new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' }).format(finished) : ''],
        ['Цена и время', [result.usage?.costUsd != null ? `$${result.usage.costUsd.toFixed(2)}` : null, result.durationSec != null ? duration(result.durationSec) : null].filter(Boolean).join(' · ')],
    ].filter(([, value]) => value);
    return (
        <>
            <Section title="Итог">
                <div className="report-paragraph md">
                    <Markdown text={report.summary} />
                </div>
            </Section>
            <Section title={`Цель · ${CLARITY[report.goalClarity] ?? report.goalClarity}`}>
                <div className="report-paragraph md">
                    <Markdown text={report.goal} />
                </div>
            </Section>
            <Section title="Как решено">
                <div className="report-paragraph md">
                    <Markdown text={report.approach} />
                </div>
            </Section>
            {report.alternatives.length > 0 && (
                <Section title={`Альтернативы · ${report.alternatives.length}`}>
                    <Rows
                        items={report.alternatives.map((alternative, index) => (
                            <div key={index} className="alternative md selectable">
                                <div className="alternative__head">
                                    <span className="alternative__title">
                                        <Markdown text={alternative.title} />
                                    </span>
                                    {alternative.better && <span className="tag tag--green">стоит рассмотреть</span>}
                                    <span className="tag">{SWITCH_COST[alternative.switchCost] ?? alternative.switchCost}</span>
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
                <Section title={`Можно проще · ${report.simpler.length}`}>
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
                <Section title={`Серьёзные риски · ${report.risks.length}`}>
                    <Rows
                        divider="row-divider row-divider--tag"
                        items={report.risks.map((place, index) => (
                            <PlaceRow key={index} place={place} marker={<span className={`tag ${place.level === 'P0' ? 'tag--red' : 'tag--orange'}`}>{place.level ?? 'P1'}</span>} />
                        ))}
                    />
                </Section>
            )}
            {report.questions.length > 0 && (
                <Section title={`Вопросы автору · ${report.questions.length}`}>
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
            <Section title="Подробности">
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
        if (error || !text) return setCommandError(error ? errorText(error) : 'Отчёт пуст: копировать нечего');
        try {
            await navigator.clipboard.writeText(text);
        } catch (failure) {
            return setCommandError(`Не удалось скопировать в буфер обмена: ${String(failure)}`);
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
            .catch((failure) => setCommandError(`Не удалось сохранить картинку: ${String(failure)}`));
        setSaving(false);
    };

    const started = parse(arch?.startedAt);
    const verdict = VERDICTS[result?.report.verdict ?? ''] ?? [result?.report.verdict ?? '', 'i-verdict-discuss', 'var(--label-2)'];
    const status = !arch ? null : arch.state === 'queued' ? (
        <span className="report-status">
            <Icon id="i-clock" />
            <span className="report-status__text" style={{ color: 'var(--label-2)' }}>
                {result ? 'В очереди. Ниже — прошлый отчёт' : 'В очереди'}
            </span>
        </span>
    ) : arch.state === 'running' ? (
        <span className="report-status" style={tone('var(--blue)')}>
            <Icon id="i-hourglass" className="icon hourglass" />
            <span className="report-status__text">
                {`Идёт ревью${started ? ` · ${duration((now - started.getTime()) / 1000)}` : ''}${result ? '. Ниже — прошлый отчёт' : ''}`}
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
            <span className="report-status__text selectable">{arch.error?.split('\n').filter(Boolean).pop() ?? 'Не удалось'}</span>
        </span>
    );

    const rerun = () => {
        onClose();
        onRerun(pr);
    };

    return (
        <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()} onKeyDown={(event) => event.key === 'Escape' && onClose()}>
            <div className="sheet sheet--wide sheet--tall" role="dialog" aria-label={`Архитектурное ревью #${pr.id}`}>
                <div className="sheet__head">
                    <div className="sheet__titles" ref={head}>
                        <div className="sheet__title">Архитектурное ревью #{pr.id}</div>
                        <div className="sheet__subtitle sheet__subtitle--line">{pr.title}</div>
                    </div>
                    <button className="round-button round-button--close" title="Закрыть" onClick={onClose}>
                        <Icon id="i-close" />
                    </button>
                </div>
                {status}
                {commandError && <CommandError text={commandError} onClose={() => setCommandError(null)} />}
                {result && !active && stale && (
                    <div className="banner banner--warning">
                        <Icon id="i-history" className="icon banner__icon" />
                        <div className="banner__body">
                            <div className="banner__title">Отчёт устарел</div>
                            <div className="banner__text">
                                Он снят на коммите {result.head}, а в PR уже {pr.head}. Решение могло измениться — перезапустите ревью.
                            </div>
                        </div>
                    </div>
                )}
                <div className="sheet__body" ref={body}>
                    {!arch && <div className="section__empty">Архитектурного ревью этого PR ещё не было</div>}
                    {arch?.state === 'failed' && arch.error?.includes('\n') && (
                        <div className="section" data-skip-export="true">
                            <div className="section__header">Вывод</div>
                            <div className="section__card">
                                <div className="output selectable">{arch.error}</div>
                            </div>
                        </div>
                    )}
                    {result && <ReportView result={result} finishedAt={arch?.finishedAt} name={name} />}
                </div>
                <div className="sheet__footer">
                    <button className="button" onClick={() => openUrl(pr.url).catch(() => {})}>
                        Открыть PR
                    </button>
                    <button className="button" disabled={!result} onClick={copyMarkdown}>
                        {copied ? 'Скопировано' : 'Скопировать markdown'}
                    </button>
                    <button className="square-button" title="Сохранить отчёт картинкой в «Загрузки»" disabled={!result || saving} style={result ? undefined : { opacity: 0.4 }} onClick={saveImage}>
                        <Icon id={saving ? 'i-spinner' : 'i-camera'} />
                    </button>
                    <span className="spacer" />
                    {active ? (
                        <button className="button button--destructive" onClick={() => api.POST('/arch/{repo}/{pr}/stop', { params: { path: { repo, pr: prId } } })}>
                            Прервать
                        </button>
                    ) : stale ? (
                        <button className="button button--prominent" autoFocus onClick={rerun}>
                            Перезапустить
                        </button>
                    ) : (
                        <button className="button" onClick={rerun}>
                            {arch ? 'Запустить снова' : 'Запустить'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};
