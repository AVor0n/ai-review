import { openUrl } from '@tauri-apps/plugin-opener';
import { Fragment, useState, type CSSProperties } from 'react';
import type { TokenInfo } from '../model/derive';
import { parse } from '../model/format';
import type { Config, Secret } from '../model/types';
import { CloseButton, Select, SheetFrame } from './controls';
import { ISSUE_URLS, lifetimeOptions, saveCommand, tokenStatus } from './model';

// Лист «Токены» — перенос TokensSheet из menubar/SettingsView.swift; «Keychain» из текстов убран — на Windows токены в хранилище WSL
export const TokensSheet = ({
    tokens,
    secrets,
    config,
    platform,
    cli,
    onLifetime,
    onCopy,
    onClose,
}: {
    tokens: TokenInfo[];
    secrets: Secret[];
    config: Config;
    platform: 'mac' | 'win';
    cli: string;
    onLifetime: (id: string, days: number) => void;
    onCopy: (text: string) => Promise<boolean>;
    onClose: () => void;
}) => {
    const [copied, setCopied] = useState<string | null>(null);
    const copy = async (text: string, key: string) => {
        if (await onCopy(text)) setCopied(key);
    };

    return (
        <SheetFrame width={560} label="Токены" onClose={onClose}>
            <div className="sheet__head">
                <span className="sheet__titles">
                    <span className="sheet__title">Токены</span>
                </span>
                <CloseButton onClose={onClose} />
            </div>
            <div className="section__card">
                {tokens.map((token, index) => {
                    const secret = secrets.find((item) => item.id === token.id);
                    const status = tokenStatus(token, parse(secret?.savedAt));
                    const service = secret?.service ?? (token.id === 'bitbucket' ? config.bitbucket?.keychainService : config.agents[token.id]?.keychainService);
                    // Аккаунт заведённой записи Keychain (как saved?.account в Tokens.swift): иначе команда добавит вторую запись рядом со старой
                    const account = secret?.account ?? (token.id === 'bitbucket' ? (config.bitbucket?.email ?? 'bitbucket') : token.id);
                    const command = saveCommand(token, service, account, platform, cli);
                    const url = ISSUE_URLS[token.id];
                    return (
                        <Fragment key={token.id}>
                            {index > 0 && <div className="row-divider" />}
                            <div className="card-pad" style={{ gap: 8 }}>
                                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                                    <span className="settings-row__text">
                                        <span style={{ fontWeight: 'var(--weight-medium)' }}>{token.title}</span>
                                        <span className="settings-row__sub" style={{ whiteSpace: 'normal', ...(status.color ? { color: status.color } : {}) }}>
                                            {status.text}
                                        </span>
                                    </span>
                                    <Select
                                        options={lifetimeOptions(token.lifetimeDays)}
                                        value={token.lifetimeDays === null ? 'unset' : String(token.lifetimeDays)}
                                        width={120}
                                        title="Срок, выбранный при выпуске токена"
                                        onSelect={(id) => Number.isInteger(Number(id)) && onLifetime(token.id, Number(id))}
                                    />
                                </div>
                                <div style={{ display: 'flex', gap: 16 }}>
                                    {url ? (
                                        <button className="link-button" title={url} onClick={() => openUrl(url).catch(() => {})}>
                                            Выпустить новый ↗
                                        </button>
                                    ) : (
                                        <button className="link-button" title="Выполните в терминале: команда откроет браузер и выведет новый токен" onClick={() => copy('claude setup-token', `issue-${token.id}`)}>
                                            {copied === `issue-${token.id}` ? 'Скопировано' : 'Скопировать «claude setup-token»'}
                                        </button>
                                    )}
                                    <button className="link-button" title={command} onClick={() => copy(command, `save-${token.id}`)}>
                                        {copied === `save-${token.id}` ? 'Скопировано' : 'Скопировать команду сохранения'}
                                    </button>
                                </div>
                            </div>
                        </Fragment>
                    );
                })}
            </div>
            <div className="section__footer" style={{ padding: 0 } as CSSProperties}>
                Срок в самом токене не прочитать: он считается от даты сохранения. Выпустите новый токен, сохраните его командой из буфера — дата обновится, предупреждение пропадёт.
            </div>
        </SheetFrame>
    );
};
