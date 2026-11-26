import { invoke } from '@tauri-apps/api/core';
import { toCanvas } from 'html-to-image';

// Снимок вкладки целиком, без прокрутки: PNG 2× в текущей теме, ширина поповера, в «Загрузки», затем файл открывается — как ImageExport.swift.
// Вкладка снимается по частям и склеивается: высокую копию целиком WebKit не рисует, обрезает сверху
const SCALE = 2;

const stamp = () => {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
};

// Цвет графиков задан переменной --c: в копии для снимка она не раскрывается, поэтому на время снимка — готовые цвета
const freezeSvgColors = (root: HTMLElement) => {
    const elements = [...root.querySelectorAll<SVGElement>('svg *')];
    const saved = elements.map((element) => element.getAttribute('style'));
    for (const element of elements) {
        const style = getComputedStyle(element);
        element.style.fill = style.fill;
        element.style.stroke = style.stroke;
    }
    return () => elements.forEach((element, index) => (saved[index] === null ? element.removeAttribute('style') : element.setAttribute('style', saved[index]!)));
};

export const exportImage = async (content: HTMLElement, name: string) => {
    const root = getComputedStyle(document.documentElement);
    const top = parseFloat(root.getPropertyValue('--space-16')) || 0;
    const width = parseFloat(root.getPropertyValue('--popover-width')) || content.offsetWidth;
    const area = content.getBoundingClientRect();
    const left = (width - area.width) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = width * SCALE;
    canvas.height = (content.scrollHeight + top + left) * SCALE;
    const context = canvas.getContext('2d')!;
    context.fillStyle = getComputedStyle(content.closest('.app') ?? content).backgroundColor;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const restore = freezeSvgColors(content);
    try {
        for (const part of [...content.children] as HTMLElement[]) {
            const box = part.getBoundingClientRect();
            const options = { pixelRatio: SCALE, width: box.width, height: box.height };
            // WebKit отдаёт первый снимок без картинок (знаки моделей ещё грузятся), поэтому такие части снимаем дважды
            if (part.querySelector('.model-mark')) await toCanvas(part, options);
            const image = await toCanvas(part, options);
            context.drawImage(image, (left + box.left - area.left) * SCALE, (top + box.top - area.top) * SCALE);
        }
    } finally {
        restore();
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Не удалось собрать картинку');
    await invoke('save_image', new Uint8Array(await blob.arrayBuffer()), { headers: { 'x-file-name': `${name}-${stamp()}.png` } });
};
