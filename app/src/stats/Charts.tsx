import { useState } from 'react';
import { SELECTION_RULES_DATE, startOfDay, weekClosed, weekOf, weekShare, type DayValue, type NoiseWeek } from './data';
import { dayFull, dayShort } from './format';

// Графики — своё SVG по классам .chart* из product/design/web/components.css, размеры — как в макете
// 2026-11-26-tauri-stats.html: ширина области 724 (карточка 748 минус поля .chart)
const WIDTH = 724;
const AXIS = 34;
const DAY_MS = 86_400_000;
const PLOT_WIDTH = WIDTH - AXIS;

// Круглый верх шкалы: 4 деления по 1, 2, 2,5 или 5 с нужным порядком
const niceMax = (value: number) => {
    if (value <= 0) return 1;
    const step = 10 ** Math.floor(Math.log10(value));
    const factor = [1, 2, 2.5, 5, 10].find((item) => item * step >= value / 4) ?? 10;
    return Math.ceil(value / (factor * step)) * factor * step;
};

const days = (start: Date, end: Date) => {
    const result: Date[] = [];
    for (let day = startOfDay(start); day < end; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) result.push(day);
    return result;
};

export type Series = { name: string; color: string };

// Столбец дня — стопка серий встык, скруглён только верх столбца
const barPath = (x: number, top: number, width: number, height: number, radius: number) =>
    `M${x},${top + height}V${top + radius}Q${x},${top} ${x + radius},${top}H${x + width - radius}Q${x + width},${top} ${x + width},${top + radius}V${top + height}Z`;

export const DailyChart = ({
    values,
    series,
    range,
    unit,
    axisUnit,
    reviews,
}: {
    values: DayValue[];
    series: Series[];
    range: { start: Date; end: Date };
    unit: (value: number) => string;
    axisUnit: (value: number) => string;
    reviews?: Map<number, number>;
}) => {
    const [selected, setSelected] = useState<number | null>(null);
    if (!values.length && !reviews?.size) return <div className="chart__empty">За выбранный период данных нет</div>;

    const height = 168;
    const top = 16;
    const bottom = 20;
    const plotHeight = height - top - bottom;
    const list = days(range.start, range.end);
    const step = PLOT_WIDTH / list.length;
    const barWidth = step * 0.62;
    const byDay = (day: Date) => series.map((item) => values.find((value) => value.day === day.getTime() && value.group === item.name)?.value ?? 0);
    const max = niceMax(Math.max(...list.map((day) => byDay(day).reduce((a, b) => a + b, 0))));
    const y = (value: number) => top + plotHeight - (value / max) * plotHeight;
    // Ширина дня падает с длиной периода: за неделю влезает «N ревью», за месяц — число, дальше подписи слипаются
    const reviewLabels = list.length <= 35;
    const shortLabels = list.length > 10;
    const color = (name: string) => series.find((item) => item.name === name)?.color ?? 'var(--gray)';

    const tooltip = (() => {
        if (selected === null) return null;
        const day = list[selected];
        const dayValues = values.filter((value) => value.day === day.getTime() && value.value > 0).sort((a, b) => b.value - a.value);
        const count = reviews?.get(day.getTime());
        const x = 12 + selected * step + step / 2;
        // В правой половине графика карточка встаёт слева от линии
        const style = selected > list.length / 2 ? { top: 12, right: WIDTH + 24 - x + 8 } : { top: 12, left: x + 8 };
        return (
            <div className="chart-tooltip" style={style}>
                <span className="chart-tooltip__title">{dayFull(day)}</span>
                {count != null && <span className="chart-tooltip__note">{count} ревью</span>}
                {!dayValues.length && <span className="chart-tooltip__note">{count == null ? 'нет данных' : 'без комментариев'}</span>}
                {dayValues.map((value) => (
                    <span key={value.group} className="chart-tooltip__row">
                        <span className="dot" style={{ '--c': color(value.group) } as React.CSSProperties} />
                        <span className="chart-tooltip__name">{value.group}</span>
                        <span className="chart-tooltip__value">{unit(value.value)}</span>
                    </span>
                ))}
            </div>
        );
    })();

    return (
        <div className={`chart${selected !== null ? ' chart--selected' : ''}`}>
            <svg viewBox={`0 0 ${WIDTH} ${height}`} height={height} onMouseLeave={() => setSelected(null)}>
                {[0, 1, 2, 3, 4].map((index) => {
                    const value = (max / 4) * index;
                    return (
                        <g key={index}>
                            <line className="chart__grid" x1={0} x2={PLOT_WIDTH} y1={y(value)} y2={y(value)} />
                            <text className="chart__axis-label" x={PLOT_WIDTH + 6} y={y(value) + 3}>
                                {axisUnit(value)}
                            </text>
                        </g>
                    );
                })}
                {list.map((day, index) =>
                    day.getDay() === 1 ? (
                        <g key={`x${index}`}>
                            <line className="chart__grid chart__grid--x" x1={index * step} x2={index * step} y1={top} y2={height - 4} />
                            <text className="chart__axis-label" x={index * step + 2} y={height - 4}>
                                {dayShort(day)}
                            </text>
                        </g>
                    ) : null,
                )}
                {selected !== null && <line className="chart__cursor" x1={selected * step + step / 2} x2={selected * step + step / 2} y1={top - 4} y2={top + plotHeight} />}
                {list.map((day, index) => {
                    const parts = byDay(day);
                    const last = parts.reduce((found, value, part) => (value ? part : found), -1);
                    const x = index * step + (step - barWidth) / 2;
                    const mark = index === selected ? ' is-selected' : '';
                    let stacked = 0;
                    const count = reviews?.get(day.getTime());
                    return (
                        <g key={day.getTime()}>
                            {parts.map((value, part) => {
                                if (!value) return null;
                                const barHeight = (value / max) * plotHeight;
                                const barTop = y(stacked + value);
                                stacked += value;
                                return <path key={part} className={`chart__bar${mark}`} d={barPath(x, barTop, barWidth, barHeight, part === last ? Math.min(3, barHeight / 2) : 0)} style={{ '--c': series[part].color } as React.CSSProperties} />;
                            })}
                            {reviewLabels && count != null && (
                                <text className={`chart__value${mark}`} x={x + barWidth / 2} y={y(stacked) - 3} textAnchor="middle">
                                    {shortLabels ? count : `${count} ревью`}
                                </text>
                            )}
                            <rect x={index * step} y={0} width={step} height={top + plotHeight} fill="transparent" onMouseEnter={() => setSelected(index)} />
                        </g>
                    );
                })}
            </svg>
            <div className="legend">
                {series.map((item) => (
                    <span key={item.name} className="legend__item">
                        <span className="dot" style={{ '--c': item.color } as React.CSSProperties} />
                        {item.name}
                    </span>
                ))}
            </div>
            {tooltip}
        </div>
    );
};

// Доля отклонённых по неделям; столбец — от понедельника до воскресенья, чтобы линия новых правил легла на границу недель
export const NoiseChart = ({ weeks, start, end }: { weeks: NoiseWeek[]; start: Date; end: Date }) => {
    if (!weeks.length) return <div className="chart__empty">За выбранный период закрытых замечаний нет</div>;
    const height = 180;
    const top = 4;
    const bottom = 20;
    const plotHeight = height - top - bottom;
    const from = weekOf(start).getTime();
    const to = weekOf(end).getTime() + 7 * DAY_MS;
    const x = (time: number) => ((time - from) / (to - from)) * PLOT_WIDTH;
    const y = (value: number) => top + plotHeight - (value / 100) * plotHeight;
    const starts: number[] = [];
    for (let week = new Date(from); week.getTime() < to; week = new Date(week.getFullYear(), week.getMonth(), week.getDate() + 7)) starts.push(week.getTime());
    const rules = SELECTION_RULES_DATE.getTime();
    return (
        <div className="chart chart--weeks">
            <svg viewBox={`0 0 ${WIDTH} ${height}`} height={height}>
                {[0, 25, 50, 75, 100].map((value) => (
                    <g key={value}>
                        <line className="chart__grid" x1={0} x2={PLOT_WIDTH} y1={y(value)} y2={y(value)} />
                        <text className="chart__axis-label" x={PLOT_WIDTH + 6} y={y(value) + 3}>
                            {value}%
                        </text>
                    </g>
                ))}
                {starts.map((week) => (
                    <g key={week}>
                        <line className="chart__grid chart__grid--x" x1={x(week)} x2={x(week)} y1={top} y2={height - 4} />
                        <text className="chart__axis-label" x={x(week) + 2} y={height - 4}>
                            {dayShort(new Date(week))}
                        </text>
                    </g>
                ))}
                {weeks.map((week) => {
                    const x0 = x(week.week + 0.6 * DAY_MS);
                    const x1 = x(week.week + 6.4 * DAY_MS);
                    const share = weekShare(week) * 100;
                    return (
                        <g key={week.week}>
                            <rect className="chart__bar" x={x0} y={y(share)} width={x1 - x0} height={(share / 100) * plotHeight} rx={3} style={{ '--c': 'var(--fate-dismissed)' } as React.CSSProperties} />
                            <text className="chart__value" x={(x0 + x1) / 2} y={y(share) - 3} textAnchor="middle">
                                {week.dismissed}/{weekClosed(week)}
                            </text>
                        </g>
                    );
                })}
                {/* Подпись слева от линии: справа от неё только текущая неделя, и текст обрезался бы краем */}
                {rules > start.getTime() && rules < end.getTime() && (
                    <>
                        <line className="chart__rule" x1={x(rules)} x2={x(rules)} y1={top} y2={top + plotHeight} />
                        <text className="chart__rule-label" x={x(rules) - 3} y={top - 6} textAnchor="end">
                            новые правила отбора
                        </text>
                    </>
                )}
            </svg>
        </div>
    );
};
