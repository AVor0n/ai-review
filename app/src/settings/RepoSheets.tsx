import { Fragment, useState } from 'react';
import { Icon } from '../components/Icon';
import { t } from '../i18n';
import { CloseButton, SheetFrame } from './controls';

type Run = (pattern: string) => Promise<string | null>;

// Новый репозиторий — перенос AddRepoSheet: сервис проверяет доступ по токену Bitbucket, ошибка — его текстом
export const AddRepoSheet = ({ onAdd, onClose }: { onAdd: (ref: string) => Promise<string | null>; onClose: () => void }) => {
    const [ref, setRef] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const value = ref.trim();
    const add = async () => {
        if (busy || !value) return;
        setBusy(true);
        setError(null);
        const failure = await onAdd(value);
        setBusy(false);
        if (failure) setError(failure);
        else onClose();
    };

    return (
        <SheetFrame width={520} label={t('settings.addRepo.title')} onClose={onClose}>
            <div className="sheet__head">
                <span className="sheet__titles">
                    <span className="sheet__title">{t('settings.addRepo.title')}</span>
                </span>
            </div>
            <div className="labeled" style={{ gap: 6 }}>
                <input
                    autoFocus
                    spellCheck={false}
                    className="text-field"
                    style={{ flex: 'none' }}
                    value={ref}
                    placeholder={t('settings.addRepo.placeholder')}
                    onChange={(event) => setRef(event.target.value)}
                    onKeyDown={(event) => event.key === 'Enter' && add()}
                />
                <span className="info-card__body">{t('settings.addRepo.hint')}</span>
            </div>
            {error && (
                <span className="form-message selectable" style={{ '--c': 'var(--red)' } as React.CSSProperties}>
                    {error}
                </span>
            )}
            <div className="sheet__footer">
                {busy && (
                    <>
                        <Icon id="i-spinner" />
                        <span style={{ color: 'var(--label-2)' }}>{t('settings.addRepo.checking')}</span>
                    </>
                )}
                <span className="spacer" />
                <button className="button" onClick={onClose}>
                    {t('common.action.cancel')}
                </button>
                <button className="button button--prominent" disabled={busy || !value} onClick={add}>
                    {t('settings.addRepo.add')}
                </button>
            </div>
        </SheetFrame>
    );
};

// Исключения из диффа — перенос IgnoreSheet. Поле добавления вне прокрутки: в длинном списке оно иначе уезжает вниз
export const IgnoreSheet = ({ patterns, onAdd, onRemove, onClose }: { patterns: string[]; onAdd: Run; onRemove: Run; onClose: () => void }) => {
    const [pattern, setPattern] = useState('');
    const [error, setError] = useState<string | null>(null);
    const run = async (request: Promise<string | null>) => setError(await request);
    const add = async () => {
        const value = pattern.trim();
        if (!value) return;
        setPattern('');
        await run(onAdd(value));
    };

    return (
        <SheetFrame width={520} label={t('settings.ignore.title')} onClose={onClose}>
            <div className="sheet__head">
                <span className="sheet__titles">
                    <span className="sheet__title">{t('settings.ignore.title')}</span>
                    <span className="sheet__subtitle">{t('settings.ignore.subtitle')}</span>
                </span>
                <CloseButton onClose={onClose} />
            </div>
            <div className="section__card" style={{ height: 200, overflow: 'auto' }}>
                {patterns.map((item, index) => (
                    <Fragment key={item}>
                        {index > 0 && <div className="row-divider" />}
                        <div className="settings-row" style={{ minHeight: 0, paddingBlock: 7 }}>
                            <span className="settings-row__title settings-row__value--mono selectable">{item}</span>
                            <button className="icon-button icon-button--remove" title={t('settings.ignore.remove')} onClick={() => run(onRemove(item))}>
                                <Icon id="i-minus-circle-fill" />
                            </button>
                        </div>
                    </Fragment>
                ))}
            </div>
            <div className="input-card">
                <Icon id="i-plus-circle-fill" style={{ color: 'var(--green)' }} />
                <input spellCheck={false} value={pattern} placeholder={t('settings.ignore.placeholder')} onChange={(event) => setPattern(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && add()} />
            </div>
            {error && (
                <span className="form-message selectable" style={{ '--c': 'var(--red)' } as React.CSSProperties}>
                    <Icon id="i-warning-fill" />
                    {error}
                </span>
            )}
        </SheetFrame>
    );
};
