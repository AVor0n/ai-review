import { invoke } from '@tauri-apps/api/core';
import { toPng } from 'html-to-image';
import icons from '../../../product/design/web/icons.svg?raw';

// Снимок вкладки целиком, без прокрутки: PNG 2× в текущей теме, ширина поповера, в «Загрузки», затем файл открывается — как ImageExport.swift.
// Копия содержимого рисуется вне экрана на всю высоту; иконки спрайта встраиваются в копию: внешние ссылки <use> в картинку не попадают
const sprite = new DOMParser().parseFromString(icons, 'image/svg+xml');

const inlineIcons = (root: HTMLElement) => {
    for (const use of root.querySelectorAll('use')) {
        const id = (use.getAttribute('href') ?? '').split('#')[1];
        const symbol = id ? sprite.getElementById(id) : null;
        const svg = use.closest('svg');
        if (!symbol || !svg) continue;
        svg.setAttribute('viewBox', symbol.getAttribute('viewBox') ?? '');
        svg.innerHTML = symbol.innerHTML;
        if (symbol.getAttribute('fill')) svg.setAttribute('fill', symbol.getAttribute('fill')!);
    }
};

const stamp = () => {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
};

export const exportImage = async (content: HTMLElement, name: string) => {
    const holder = document.createElement('div');
    holder.className = 'app';
    holder.style.cssText = 'position: fixed; left: -100000px; top: 0; width: var(--popover-width); padding-top: var(--space-16)';
    const copy = content.cloneNode(true) as HTMLElement;
    inlineIcons(copy);
    holder.append(copy);
    document.body.append(holder);
    try {
        const url = await toPng(holder, { pixelRatio: 2, backgroundColor: getComputedStyle(holder).backgroundColor });
        const bytes = Uint8Array.from(atob(url.split(',')[1]), (char) => char.charCodeAt(0));
        await invoke('save_image', bytes, { headers: { 'x-file-name': `${name}-${stamp()}.png` } });
    } finally {
        holder.remove();
    }
};
