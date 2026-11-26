import { Fragment, useState, type CSSProperties, type ReactNode } from 'react';
import { LEVELS, fateClosed, fateTotal, perThousand, type Density, type Fate } from './data';
import { decimal, levelCount } from './format';
import { Icon } from '../components/Icon';

// Строки вкладки «Статистика» — разметка из шаблона tpl-stats макета 2026-11-26-tauri-stats.html
const color = (value: string) => ({ '--c': value }) as CSSProperties;
export const levelColor = (level: string) => `var(--level-${level.toLowerCase()})`;

export const Dot = ({ c }: { c: string }) => <span className="dot" style={color(c)} />;

export const Title = ({ icon, children }: { icon: string; children: ReactNode }) => (
    <div className="stats-title">
        <Icon id={icon} />
        {children}
    </div>
);

export const Kpi = ({ title, value, detail }: { title: string; value: string; detail?: string }) => (
    <div className="kpi">
        <span className="kpi__title">{title}</span>
        <span className="kpi__value">{value}</span>
        <span className="kpi__detail">{detail ?? ' '}</span>
    </div>
);

export const Card = ({ header, footer, children }: { header?: ReactNode; footer?: string; children: ReactNode }) => (
    <div className="section">
        {header && <div className="section__header">{header}</div>}
        <div className="section__card">{children}</div>
        {footer && <div className="section__footer">{footer}</div>}
    </div>
);

export const Empty = ({ text = 'За выбранный период данных нет' }: { text?: string }) => <div className="section__empty">{text}</div>;

// Строки через разделитель, как RowDivider между строками GroupedSection
export const Rows = ({ children }: { children: ReactNode[] }) => (
    <>
        {children.map((child, index) => (
            <Fragment key={index}>
                {index > 0 && <div className="row-divider" />}
                {child}
            </Fragment>
        ))}
    </>
);

export const Segments = <T extends string>({ options, value, onChange }: { options: { id: T; title: string }[]; value: T; onChange: (value: T) => void }) => (
    <div className="segmented segmented--dimension">
        {options.map((option) => (
            <button key={option.id} className="segmented__item" aria-selected={option.id === value} onClick={() => onChange(option.id)}>
                {option.title}
            </button>
        ))}
    </div>
);

// Строка с долей от целого: точка, подпись, полоса доли и значение справа
export const ShareRow = ({ title, detail, value, share, c }: { title: string; detail?: string; value: string; share: number; c: string }) => (
    <div className="share-row">
        <div className="share-row__label">
            <Dot c={c} />
            <div className="share-row__text">
                <span className="share-row__title">{title}</span>
                {detail && <span className="share-row__detail">{detail}</span>}
            </div>
        </div>
        <div className="bar">{share > 0 && <div className="bar__fill" style={{ ...color(c), '--share': `${Math.min(share, 1) * 100}%` } as CSSProperties} />}</div>
        <span className="share-row__value">{value}</span>
    </div>
);

export const StatLine = ({ title, value, c }: { title: string; value: string; c?: string }) => (
    <div className={`stat-line${c ? ' stat-line--colored' : ''}`}>
        {c && <Dot c={c} />}
        <span className="stat-line__title">{title}</span>
        <span className="stat-line__value">{value}</span>
    </div>
);

const FATE_PARTS = [
    { title: 'Исправлено', key: 'addressed', c: 'var(--fate-addressed)' },
    { title: 'Отклонено', key: 'dismissed', c: 'var(--fate-dismissed)' },
    { title: 'Ждут правки', key: 'waiting', c: 'var(--fate-waiting)' },
] as const;

export const FateRow = ({ name, agent, fate }: { name: string; agent?: string; fate: Fate }) => (
    <div className="fate-row">
        <div className="fate-row__head">
            {agent && <span className={`model-mark model--${agent}`} />}
            <span className="fate-row__name">{name}</span>
            {fateClosed(fate) > 0 && <span className="fate-row__note">исправлено {Math.floor((fate.addressed * 100) / fateClosed(fate))}% закрытых</span>}
            <span className="fate-row__total">{fateTotal(fate)} замеч.</span>
        </div>
        <div className="stack">
            {FATE_PARTS.filter((part) => fate[part.key] > 0).map((part) => (
                <span key={part.key} className="stack__part" style={{ ...color(part.c), '--part': fate[part.key] } as CSSProperties} />
            ))}
        </div>
        <div className="legend">
            {FATE_PARTS.map((part) => (
                <span key={part.key} className="legend__item">
                    <Dot c={part.c} />
                    {part.title} <span className="legend__count">{fate[part.key]}</span>
                </span>
            ))}
        </div>
    </div>
);

// Наведение на отрезок уровня: остальные бледнеют, над отрезком — подсказка; приглушённая строка под курсором яркая
export const DensityRow = ({ row, scale }: { row: Density; scale: number }) => {
    const [hover, setHover] = useState<string | null>(null);
    const visible = LEVELS.filter((level) => (row.findings[level] ?? 0) > 0);
    return (
        <div className={`density-row${row.isLowVolume && !hover ? ' density-row--low' : ''}`}>
            <div className="density-row__label">
                <span className="density-row__name">{row.name}</span>
                <span className="density-row__meta">
                    {row.prs} PR · {row.lines.toLocaleString('ru')} строк · {row.total} замеч.{row.isLowVolume ? ' · мало данных' : ''}
                </span>
            </div>
            <div className={`density-row__bars${hover ? ' density-row__bars--hover' : ''}`}>
                {visible.map((level) => {
                    const count = row.findings[level] ?? 0;
                    return (
                        <span
                            key={level}
                            className={`density-row__bar${hover === level ? ' is-hover' : ''}`}
                            style={{ ...color(levelColor(level)), '--w': `${Math.min(perThousand(row, count) / scale, 1) * 100}%`, position: 'relative' } as CSSProperties}
                        >
                            {/* Зона наведения шире тонкой полосы: попасть в узкий кусок курсором проще */}
                            <span style={{ position: 'absolute', inset: -6 }} onMouseEnter={() => setHover(level)} onMouseLeave={() => setHover((current) => (current === level ? null : current))} />
                            {hover === level && (
                                <span className="level-tooltip">
                                    <span className="level-tooltip__head">
                                        <Dot c={levelColor(level)} />
                                        {levelCount(level, count)}
                                        <span className="level-tooltip__level">{level}</span>
                                    </span>
                                    <span className="level-tooltip__note">{decimal(perThousand(row, count))} на 1000 строк</span>
                                </span>
                            )}
                        </span>
                    );
                })}
            </div>
            <span className="density-row__value">{decimal(row.density)}</span>
        </div>
    );
};
