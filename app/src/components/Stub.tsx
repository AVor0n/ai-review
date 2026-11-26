import type { Stub as StubContent } from '../model/stubs';
import { Icon } from './Icon';

// Заглушка неперенесённого экрана: на Mac — текст про старое окно, на Windows — команды WSL с «Скопировать»
export const Stub = ({ stub, onCopy }: { stub: StubContent; onCopy: (text: string) => void }) => (
    <div className="screen stub">
        <div className="empty-state">
            <Icon id="i-clock" className="icon empty-state__icon" />
            <div className="empty-state__title">{stub.title}</div>
            <div className="empty-state__text">{stub.text}</div>
            {stub.commands.length > 0 && (
                <div className="command-list">
                    {stub.commands.map((command) => (
                        <div key={command.text} className="command">
                            <div className="command__body">
                                <div className="command__text selectable">{command.text}</div>
                                <div className="command__note">{command.note}</div>
                            </div>
                            <button className="icon-button" title="Скопировать команду" onClick={() => onCopy(command.text)}>
                                <Icon id="i-copy" />
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    </div>
);
