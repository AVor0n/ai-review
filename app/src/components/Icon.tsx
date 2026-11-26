import type { CSSProperties } from 'react';
import icons from '../../../product/design/web/icons.svg?raw';

// Иконки спрайта дизайн-системы рисуются прямо в разметке: так их видит и снимок вкладки картинкой —
// внешние ссылки <use href="icons.svg#…"> в картинку не попадают. i-spinner — класс spinner, он сам вращается
const sprite = new DOMParser().parseFromString(icons, 'image/svg+xml');
const symbols = new Map<string, { viewBox: string; fill: string | null; body: string }>();

const symbol = (id: string) => {
    if (!symbols.has(id)) {
        const node = sprite.getElementById(id);
        symbols.set(id, { viewBox: node?.getAttribute('viewBox') ?? '0 0 16 16', fill: node?.getAttribute('fill') ?? null, body: node?.innerHTML ?? '' });
    }
    return symbols.get(id)!;
};

export const Icon = ({ id, className, style }: { id: string; className?: string; style?: CSSProperties }) => {
    const { viewBox, fill, body } = symbol(id);
    return <svg className={className ?? (id === 'i-spinner' ? 'spinner' : 'icon')} style={style} viewBox={viewBox} fill={fill ?? undefined} aria-hidden="true" dangerouslySetInnerHTML={{ __html: body }} />;
};

// Текст правила с `кодом` — как Markdown в LocalizedStringKey у SwiftUI
export const InlineCode = ({ text }: { text: string }) => (
    <>{text.split(/`([^`]+)`/).map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part))}</>
);
