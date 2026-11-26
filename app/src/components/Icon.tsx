import type { CSSProperties } from 'react';
import icons from '../../../product/design/web/icons.svg?url';

// Иконка из спрайта дизайн-системы; i-spinner — класс spinner, он сам вращается
export const Icon = ({ id, className, style }: { id: string; className?: string; style?: CSSProperties }) => (
    <svg className={className ?? (id === 'i-spinner' ? 'spinner' : 'icon')} style={style} aria-hidden="true">
        <use href={`${icons}#${id}`} />
    </svg>
);

// Текст правила с `кодом` — как Markdown в LocalizedStringKey у SwiftUI
export const InlineCode = ({ text }: { text: string }) => (
    <>{text.split(/`([^`]+)`/).map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part))}</>
);
