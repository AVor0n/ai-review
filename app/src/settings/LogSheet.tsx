import { invoke } from '@tauri-apps/api/core';
import { Fragment, useState, type CSSProperties } from 'react';
import { Icon } from '../components/Icon';
import { t } from '../i18n';
import { CloseButton } from './controls';
import { LOG_LIMIT, logTime, isLong, type LogEntry } from './log';

// Лист «Журнал» поверх «Настроек» — перенос LogView и LogRow из menubar/LogView.swift.
// Разметка — шаблоны tpl-sheet-log*, tpl-log-* и tpl-row-* макета 2026-11-26-tauri-log.html
const ERRORS_ONLY_KEY = 'pr-reviewer.logErrorsOnly';

const storedErrorsOnly = () => {
    try {
        return localStorage.getItem(ERRORS_ONLY_KEY) === 'true';
    } catch {
        return false;
    }
};

// Путь в подсказке — с ~ вместо домашней папки, как его пишут в терминале
const shortPath = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/)/, '~');

export const LogSheet = ({ entries, file, onError, onClose }: { entries: LogEntry[]; file: string | null; onError: (text: string) => void; onClose: () => void }) => {
    const [errorsOnly, setErrorsOnly] = useState(storedErrorsOnly);
    // Раскрытые записи помнятся, пока лист открыт; id — смещение записи в файле, оно не съезжает с новыми записями
    const [expanded, setExpanded] = useState<Set<number>>(new Set());
    const shown = entries.filter((entry) => !errorsOnly || entry.isError).slice(0, LOG_LIMIT);

    const choose = (value: boolean) => {
        setErrorsOnly(value);
        try {
            localStorage.setItem(ERRORS_ONLY_KEY, String(value));
        } catch {
            // Без хранилища выбор живёт до закрытия листа
        }
    };

    const toggle = (id: number) => setExpanded((current) => (current.has(id) ? new Set([...current].filter((value) => value !== id)) : new Set([...current, id])));

    return (
        <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()} onKeyDown={(event) => event.key === 'Escape' && onClose()}>
            <div className="sheet sheet--wide sheet--tall" role="dialog" aria-label={t('settings.log.title')}>
                <div className="sheet__head">
                    <span className="sheet__titles">
                        <span className="sheet__title">{t('settings.log.title')}</span>
                    </span>
                    <CloseButton onClose={onClose} />
                </div>
                <div className="sheet__bar">
                    <div className="segmented" style={{ '--segment-width': '100px' } as CSSProperties}>
                        <button className="segmented__item" aria-selected={!errorsOnly} onClick={() => choose(false)}>
                            {t('settings.log.all')}
                        </button>
                        <button className="segmented__item" aria-selected={errorsOnly} onClick={() => choose(true)}>
                            {t('settings.log.errors')}
                        </button>
                    </div>
                    <span className="spacer" />
                    {file && (
                        <button className="link-button link-button--icon" title={shortPath(file)} onClick={() => invoke('open_path', { path: file }).catch((reason) => onError(String(reason)))}>
                            <Icon id="i-open-external" />
                            {t('settings.log.openFile')}
                        </button>
                    )}
                </div>
                <div className="sheet__body">
                    {shown.length ? (
                        <div className="section__card">
                            {shown.map((entry, index) => {
                                const open = expanded.has(entry.id);
                                return (
                                    <Fragment key={entry.id}>
                                        {index > 0 && <div className="row-divider row-divider--log" />}
                                        <div className={`log-row${entry.isError ? ' log-row--error' : ''}${open ? ' log-row--expanded' : ''}`}>
                                            <span className="log-row__mark">{entry.isError && <Icon id="i-warning-fill" />}</span>
                                            <div className="log-row__body">
                                                <span className="log-row__time">{logTime(entry.at)}</span>
                                                <span className="log-row__message selectable">{entry.message}</span>
                                            </div>
                                            {isLong(entry.message) && (
                                                <button className="log-row__toggle" title={open ? t('settings.log.collapse') : t('settings.log.expand')} onClick={() => toggle(entry.id)}>
                                                    <Icon id="i-chevron-down" />
                                                </button>
                                            )}
                                        </div>
                                    </Fragment>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="empty-state">
                            <Icon id={errorsOnly ? 'i-check-circle' : 'i-file-text'} className="icon empty-state__icon" />
                            <div className="empty-state__title">{errorsOnly ? t('settings.log.noErrors') : t('settings.log.empty')}</div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
