import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorText, type ApiClient } from '../api/client';
import { Icon } from '../components/Icon';
import { t, useLang } from '../i18n';
import schema from '../../../schema/config.schema.json';
import { CloseButton, SheetFrame } from './controls';
import { configProblem, highlight } from './configText';
import { configPath, fieldDescription, pathTitle } from './model';

// Редактор config.json — перенос ConfigSheet: подсветка, описание поля под курсором, проверка до записи и защита от перезаписи
const isWindows = navigator.userAgent.includes('Windows');

// config — конфиг из данных приложения: меняется по событию сервиса, когда config.json записали
export const ConfigSheet = ({ api, config, canOpenInCode, onOpenInCode, onClose }: { api: ApiClient; config: unknown; canOpenInCode: boolean; onOpenInCode: (path: string) => void; onClose: () => void }) => {
    const [file, setFile] = useState<{ path: string; text: string; modifiedAt: string } | null>(null);
    const [text, setText] = useState('');
    const [caret, setCaret] = useState(0);
    const [focused, setFocused] = useState(false);
    // changed — файл изменился, пока был открыт: оранжевым и «Перечитать»; иначе ошибка записи красным. Без text — своё сообщение, оно берётся при отрисовке и следует языку
    const [saveError, setSaveError] = useState<{ text?: string; changed: boolean } | null>(null);
    const highlighted = useRef<HTMLPreElement>(null);

    const load = useCallback(async () => {
        const { data, error } = await api.GET('/config/file');
        if (!data) return setSaveError({ text: errorText(error), changed: false });
        setFile(data);
        setText(data.text);
        setSaveError(null);
    }, [api]);

    useEffect(() => {
        load();
    }, [load]);

    // Файл изменили, пока лист открыт (переключатель в настройках, сервис, другой редактор) — говорим сразу, а не после «Сохранить»
    const opened = useRef(file);
    opened.current = file;
    useEffect(() => {
        if (!opened.current) return;
        api.GET('/config/file').then(({ data }) => {
            if (data && opened.current && data.modifiedAt !== opened.current.modifiedAt) setSaveError({ changed: true });
        });
    }, [api, config]);

    const lang = useLang();
    const problem = useMemo(() => (file ? configProblem(text) : null), [file, text, lang]);
    const path = focused ? configPath(text, caret) : [];
    const help = path.length ? fieldDescription(schema, path) : null;
    const changed = !!file && text !== file.text;

    const save = async () => {
        if (!file || !changed || problem) return;
        const { error, response } = await api.PUT('/config/file', { body: { text, modifiedAt: file.modifiedAt } });
        if (error) return setSaveError({ text: errorText(error), changed: response.status === 409 });
        onClose();
    };

    return (
        <SheetFrame width={660} label="config.json" onClose={onClose}>
            <div
                style={{ display: 'contents' }}
                onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                        event.preventDefault();
                        save();
                    }
                }}
            >
                <div className="sheet__head">
                    <span className="sheet__titles">
                        <span className="sheet__title">config.json</span>
                        <span className="sheet__subtitle" style={{ fontFamily: 'var(--font-mono)', userSelect: 'text' }}>
                            {file?.path ?? ''}
                        </span>
                    </span>
                    <CloseButton onClose={onClose} title={t('settings.closeWithoutSaving')} />
                </div>
                <div className="code-editor code-editor--live">
                    <pre ref={highlighted} aria-hidden="true">
                        {highlight(text).map((token, index) => (token.kind ? <span key={index} className={token.kind}>{token.text}</span> : <Fragment key={index}>{token.text}</Fragment>))}
                        {/* Последний перевод строки textarea показывает пустой строкой — повторяем его, иначе прокрутка разъезжается */}
                        {'\n'}
                    </pre>
                    <textarea
                        autoFocus
                        wrap="off"
                        spellCheck={false}
                        autoCorrect="off"
                        autoCapitalize="off"
                        autoComplete="off"
                        value={text}
                        onChange={(event) => {
                            setText(event.target.value);
                            setCaret(event.target.selectionStart);
                        }}
                        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
                        onFocus={() => setFocused(true)}
                        onBlur={() => setFocused(false)}
                        onScroll={(event) => {
                            if (!highlighted.current) return;
                            highlighted.current.scrollTop = event.currentTarget.scrollTop;
                            highlighted.current.scrollLeft = event.currentTarget.scrollLeft;
                        }}
                    />
                </div>
                {help ? (
                    <div className="field-help">
                        <span className="field-help__path">{pathTitle(path)}</span>
                        <span>{help}</span>
                    </div>
                ) : (
                    <div className="field-help field-help--empty">{t('settings.config.fieldEmpty')}</div>
                )}
                {saveError || problem ? (
                    <span className="form-message selectable" style={{ '--c': saveError?.changed ? 'var(--orange)' : 'var(--red)' } as React.CSSProperties}>
                        <Icon id="i-warning-fill" />
                        {saveError ? (saveError.text ?? t('settings.config.changed')) : problem}
                    </span>
                ) : (
                    <span className="form-message">{t('settings.config.applied')}</span>
                )}
                <div className="sheet__footer">
                    {canOpenInCode && file && (
                        <button
                            className="button"
                            title={t('settings.config.openInCodeHint')}
                            onClick={() => {
                                onOpenInCode(file.path);
                                onClose();
                            }}
                        >
                            {t('settings.config.openInCode')}
                        </button>
                    )}
                    {saveError?.changed && (
                        <button className="button" onClick={load}>
                            {t('settings.config.reload')}
                        </button>
                    )}
                    <span className="spacer" />
                    <button className="button button--prominent" title={isWindows ? 'Ctrl+S' : '⌘S'} disabled={!changed || !!problem || !!saveError?.changed} onClick={save}>
                        {t('common.action.save')}
                    </button>
                </div>
            </div>
        </SheetFrame>
    );
};
