import { Fragment, useState, type CSSProperties } from 'react';
import { Icon } from '../components/Icon';
import { MUTE_PERIODS } from '../model/prefs';
import { KINDS, LEVELS, REPO_KINDS, muteSummary, repoSummary, rulesFor, toggleKind, type NotificationRules, type NotificationSettings } from '../model/notifications';
import { CloseButton, NavRow, SheetFrame, Switch, popupMenu } from './controls';

// Лист «Уведомления» — перенос NotificationsSheet из menubar/SettingsView.swift.
// Репозиторий открывается внутри листа, без второго листа поверх
export const NotificationsSheet = ({
    settings,
    onChange,
    repos,
    mutedUntil,
    muted,
    onMute,
    onUnmute,
    denied,
    platform,
    onOpenSystem,
    onClose,
}: {
    settings: NotificationSettings;
    onChange: (settings: NotificationSettings) => void;
    repos: string[];
    mutedUntil: string | null;
    muted: boolean;
    onMute: (hours: number | null) => void;
    onUnmute: () => void;
    denied: boolean;
    platform: 'mac' | 'win';
    onOpenSystem: () => void;
    onClose: () => void;
}) => {
    const [repo, setRepo] = useState<string | null>(null);

    const kindRows = (kinds: typeof KINDS, rules: NotificationRules, update: (rules: NotificationRules) => void, disabled = false) =>
        kinds.map((kind, index) => (
            <Fragment key={kind.id}>
                {index > 0 && <div className="row-divider row-divider--tile-small" />}
                <div className="settings-row">
                    <span className="icon-tile icon-tile--small" style={{ '--c': kind.color } as CSSProperties}>
                        <Icon id={kind.icon} />
                    </span>
                    <span className="settings-row__text">
                        <span>{kind.title}</span>
                        <span className="settings-row__sub">{kind.detail}</span>
                    </span>
                    <Switch checked={rules.enabled.includes(kind.id)} disabled={disabled} onChange={(on) => update(toggleKind(rules, kind.id, on))} />
                </div>
                {/* Уровень — уточнение замечаний, поэтому только когда они включены */}
                {kind.id === 'findings' && rules.enabled.includes('findings') && (
                    <>
                        <div className="row-divider row-divider--tile-small" />
                        <div className="settings-row" style={{ paddingLeft: 50 }}>
                            <span className="settings-row__title">Уровень</span>
                            <div className="segmented" style={{ '--segment-width': '70px' } as CSSProperties}>
                                {LEVELS.map((level) => (
                                    <button key={level.id} className="segmented__item" aria-selected={rules.level === level.id} disabled={disabled} onClick={() => update({ ...rules, level: level.id })}>
                                        {level.title}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </>
                )}
            </Fragment>
        ));

    const own = repo ? settings.repos[repo] !== undefined : false;

    const main = (
        <>
            {denied && (
                <div className="section">
                    <div className="section__card">
                        <div className="settings-row">
                            <Icon id="i-bell-slash-fill" style={{ color: 'var(--orange)' }} />
                            <span className="settings-row__title" style={{ color: 'var(--orange)' }}>
                                {platform === 'win' ? 'Windows запретила уведомления PR Reviewer' : 'macOS запретила уведомления PR Reviewer'}
                            </span>
                            <button className="button" onClick={onOpenSystem}>
                                {platform === 'win' ? 'Открыть параметры уведомлений' : 'Открыть системные настройки'}
                            </button>
                        </div>
                    </div>
                    <div className="section__footer">Пока уведомления запрещены, настройки ниже ни на что не влияют.</div>
                </div>
            )}
            <div className="section">
                <div className="section__card">
                    <div className="settings-row">
                        <span className="settings-row__title">Не беспокоить</span>
                        {muted ? (
                            <>
                                <span className="settings-row__value" style={{ color: 'var(--orange)' }}>
                                    {muteSummary(mutedUntil)}
                                </span>
                                <button className="button" onClick={onUnmute}>
                                    Включить
                                </button>
                            </>
                        ) : (
                            <button className="button" onClick={() => popupMenu(MUTE_PERIODS.map((period) => ({ text: period.title, action: () => onMute(period.hours) })))}>
                                Выключить…
                            </button>
                        )}
                    </div>
                </div>
                <div className="section__footer">События, пропущенные за это время, не придут и после включения. Выключить можно и из меню по правому клику на иконку.</div>
            </div>
            <div className="section">
                <div className="section__header">Для всех репозиториев</div>
                <div className="section__card">{kindRows(KINDS, settings.all, (all) => onChange({ ...settings, all }))}</div>
                <div className="section__footer">Нажатие на уведомление открывает PR или тред.</div>
            </div>
            <div className="section">
                <div className="section__header">Репозитории</div>
                <div className="section__card">
                    {repos.map((slug, index) => (
                        <Fragment key={slug}>
                            {index > 0 && <div className="row-divider" />}
                            <NavRow title={slug} value={repoSummary(settings, slug)} onClick={() => setRepo(slug)} />
                        </Fragment>
                    ))}
                </div>
                <div className="section__footer">Репозиторий может следовать общим настройкам или иметь свои.</div>
            </div>
        </>
    );

    const repoScreen = repo && (
        <>
            <div className="section">
                <div className="section__card">
                    <div className="settings-row">
                        <span className="settings-row__title">Как для всех репозиториев</span>
                        {/* Свои правила начинаются с копии общих: выключение переключателя ничего сразу не меняет */}
                        <Switch
                            checked={!own}
                            onChange={(same) => {
                                const repos = { ...settings.repos };
                                if (same) delete repos[repo];
                                else repos[repo] = settings.all;
                                onChange({ ...settings, repos });
                            }}
                        />
                    </div>
                </div>
                <div className="section__footer">{own ? 'Общие настройки на этот репозиторий не действуют.' : 'Сейчас действуют общие настройки. Выключите, чтобы задать свои.'}</div>
            </div>
            <div className="section">
                <div className="section__header">События</div>
                <div className="section__card" style={own ? undefined : { opacity: 0.45 }}>
                    {kindRows(REPO_KINDS, rulesFor(settings, repo), (rules) => onChange({ ...settings, repos: { ...settings.repos, [repo]: rules } }), !own)}
                </div>
                <div className="section__footer">Ошибки сервиса не относятся к репозиторию и настраиваются только для всех.</div>
            </div>
        </>
    );

    return (
        <SheetFrame width={560} label={repo ?? 'Уведомления'} onClose={onClose}>
            <div className="sheet__head sheet__head--center">
                {repo && (
                    <button className="sheet__back" onClick={() => setRepo(null)}>
                        <Icon id="i-chevron-left" />
                        Уведомления
                    </button>
                )}
                <span className="sheet__title">{repo ?? 'Уведомления'}</span>
                <CloseButton onClose={onClose} />
            </div>
            <div className="sheet__body" style={{ '--sheet-body': '440px' } as CSSProperties}>
                {repo ? repoScreen : main}
            </div>
        </SheetFrame>
    );
};
