import { Icon } from './Icon';

// Ошибка действия в листе — тот же баннер «Не удалось выполнить команду», что в обзоре (syncError в SwiftUI)
export const CommandError = ({ text, onClose }: { text: string; onClose: () => void }) => (
    <div className="banner banner--alert" role="alert">
        <Icon id="i-warning-fill" className="icon banner__icon" />
        <div className="banner__body">
            <div className="banner__title">Не удалось выполнить команду</div>
            <div className="banner__text banner__text--clamp selectable">{text.trim()}</div>
        </div>
        <div className="banner__actions">
            <button className="close-button" title="Скрыть" onClick={onClose}>
                <Icon id="i-close" />
            </button>
        </div>
    </div>
);
