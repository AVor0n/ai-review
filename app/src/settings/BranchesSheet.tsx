import { Fragment, useState, type CSSProperties } from 'react';
import { Icon } from '../components/Icon';
import type { PullRequest } from '../model/types';
import { CloseButton, SheetFrame } from './controls';
import { isValidPattern } from './model';

// Шаблон исходных веток для фонового ревью — перенос BranchPatternSheet из menubar/SettingsView.swift:
// проверка выражения и список открытых PR, которые под него попадают, — опечатка видна сразу, до сохранения
export const BranchesSheet = ({ saved, prs, onSave, onClose }: { saved: string; prs: PullRequest[]; onSave: (pattern: string) => void; onClose: () => void }) => {
    const [text, setText] = useState(saved);
    // Пока шаблон неверный, список показывает совпадения для последнего верного — он не пропадает и не прыгает
    const [lastValid, setLastValid] = useState(saved);
    const valid = isValidPattern(text);
    const matches = (pr: PullRequest) => new RegExp(lastValid, 'i').test(pr.source);
    const save = () => {
        if (!valid) return;
        if (text !== saved) onSave(text);
        onClose();
    };

    return (
        <SheetFrame width={560} label="Ветки для ревью" onClose={onClose}>
            <div className="sheet__head">
                <span className="sheet__titles">
                    <span className="sheet__title">Ветки для ревью</span>
                    <span className="sheet__subtitle">Регулярное выражение для исходной ветки PR, без учёта регистра. Остальные PR фон пропускает, вручную их можно отревьюить кликом по иконке модели.</span>
                </span>
                <CloseButton onClose={onClose} title="Закрыть без сохранения" />
            </div>
            <div className="input-card">
                <input
                    autoFocus
                    spellCheck={false}
                    value={text}
                    placeholder="PROJ-\d+"
                    onChange={(event) => {
                        setText(event.target.value);
                        if (isValidPattern(event.target.value)) setLastValid(event.target.value);
                    }}
                    onKeyDown={(event) => event.key === 'Enter' && save()}
                />
                {!valid && (
                    <span title={text ? 'Неверное регулярное выражение — список показывает последний верный шаблон' : 'Введите шаблон'} style={{ display: 'flex', color: text ? 'var(--red)' : 'var(--label-2)' }}>
                        <Icon id="i-warning-fill" />
                    </span>
                )}
            </div>
            <div className="section">
                <div className="section__header">
                    Открытые PR · подходит {prs.filter(matches).length} из {prs.length}
                </div>
                {/* Список по прошлому шаблону приглушён, чтобы не выдавать его за результат текущего ввода */}
                <div className="section__card" style={{ height: 200, overflow: 'auto', opacity: valid ? 1 : 0.5 }}>
                    {prs.map((pr, index) => (
                        <Fragment key={`${pr.id}-${index}`}>
                            {index > 0 && <div className="row-divider row-divider--marker" />}
                            <div className="place" style={{ alignItems: 'center', paddingBlock: 7 }}>
                                <span className="place__marker" style={matches(pr) ? ({ '--c': 'var(--green)' } as CSSProperties) : undefined}>
                                    <Icon id={matches(pr) ? 'i-check-circle-fill' : 'i-minus-circle'} />
                                </span>
                                {/* Ветка — главное в строке: название PR сжимается первым */}
                                <span className="labeled__path" style={{ flex: '0 1 auto', minWidth: 0, maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={pr.source}>
                                    {pr.source}
                                </span>
                                <span style={{ flex: '1 1 0', minWidth: 0, fontSize: 'var(--text-callout)', color: 'var(--label-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    #{pr.id} {pr.title}
                                </span>
                            </div>
                        </Fragment>
                    ))}
                </div>
            </div>
            <div className="sheet__footer">
                <span className="spacer" />
                <button className="button button--prominent" disabled={!valid || text === saved} onClick={save}>
                    Сохранить
                </button>
            </div>
        </SheetFrame>
    );
};
