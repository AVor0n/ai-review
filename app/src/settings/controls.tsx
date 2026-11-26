import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import type { CSSProperties, ReactNode } from 'react';
import { Icon } from '../components/Icon';
import type { Option } from './model';

// Общие элементы управления дизайн-системы: .switch, .select, .stepper, .settings-row. Одинаковые на Mac и Windows
export type MenuEntry = { text: string; checked?: boolean; enabled?: boolean; action: () => void } | 'separator';

// Системное меню у курсора: у выбранного пункта галочка
export const popupMenu = async (entries: MenuEntry[]) => {
    const items = await Promise.all(
        entries.map((entry) =>
            entry === 'separator'
                ? PredefinedMenuItem.new({ item: 'Separator' })
                : entry.checked !== undefined
                  ? CheckMenuItem.new({ text: entry.text, checked: entry.checked, enabled: entry.enabled ?? true, action: entry.action })
                  : MenuItem.new({ text: entry.text, enabled: entry.enabled ?? true, action: entry.action }),
        ),
    );
    const menu = await Menu.new({ items });
    await menu.popup();
};

export const Switch = ({ checked, onChange, disabled, title }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; title?: string }) => (
    <input type="checkbox" className="switch" checked={checked} disabled={disabled} title={title} onChange={(event) => onChange(event.target.checked)} />
);

export const Select = ({ options, value, onSelect, width, title }: { options: Option[]; value: string; onSelect: (id: string) => void; width?: number; title?: string }) => (
    <button
        className="select"
        style={width ? ({ '--select-width': `${width}px` } as CSSProperties) : undefined}
        title={title}
        onClick={() => popupMenu(options.map((option) => ({ text: option.title, checked: option.id === value, action: () => option.id !== value && onSelect(option.id) })))}
    >
        <span className="select__value">{options.find((option) => option.id === value)?.title ?? value}</span>
        <Icon id="i-updown" />
    </button>
);

export const Stepper = ({ onStep, disabled }: { onStep: (direction: 1 | -1) => void; disabled?: boolean }) => (
    // Минус уменьшает интервал — проверки чаще; в макете подсказки кнопок перепутаны
    <span className="stepper">
        <button title="Чаще" disabled={disabled} onClick={() => onStep(-1)}>
            <Icon id="i-minus" />
        </button>
        <button title="Реже" disabled={disabled} onClick={() => onStep(1)}>
            <Icon id="i-plus" />
        </button>
    </span>
);

// Строка как в «Настройках» iOS: значение серым и шеврон, редактирование — на листе
export const NavRow = ({ title, value, mono, color, hint, onClick }: { title: string; value?: ReactNode; mono?: boolean; color?: string | null; hint?: string; onClick: () => void }) => (
    <button className="settings-row settings-row--nav" title={hint} onClick={onClick}>
        <span className="settings-row__title">{title}</span>
        {value !== undefined && value !== null && (
            <span className={`settings-row__value${mono ? ' settings-row__value--mono' : ''}`} style={color ? { color } : undefined}>
                {value}
            </span>
        )}
        <Icon id="i-chevron-right" className="icon settings-row__chevron" />
    </button>
);

export const CloseButton = ({ onClose, title = 'Закрыть' }: { onClose: () => void; title?: string }) => (
    <button className="round-button round-button--close" title={title} onClick={onClose}>
        <Icon id="i-close" />
    </button>
);

// Лист поверх поповера: закрывается кликом по фону и Escape
export const SheetFrame = ({ width, label, onClose, children }: { width: number; label: string; onClose: () => void; children: ReactNode }) => (
    <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()} onKeyDown={(event) => event.key === 'Escape' && onClose()}>
        <div className="sheet" style={{ width }} role="dialog" aria-label={label}>
            {children}
        </div>
    </div>
);
