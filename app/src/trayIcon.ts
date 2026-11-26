import { invoke } from '@tauri-apps/api/core';
import icons from '../../product/design/web/icons.svg?raw';
import claude from '../../product/design/web/logos/claude-spark.svg?raw';
import cursor from '../../product/design/web/logos/cursor-cube.svg?raw';
import codex from '../../product/design/web/logos/openai-blossom.svg?raw';
import { t } from './i18n';
import type { MenuEntry, TrayIcon } from './model/tray';

// Значок трея рисуется здесь из спрайта иконок и знаков моделей дизайн-системы: так он совпадает с поповером.
// Rust получает готовые кадры PNG и сам меняет их по таймеру — вращение и мигание идут и при закрытом поповере
const MARKS: Record<string, string> = { claude, codex, cursor };
// Вращение знака модели — период --spin-period (2 с), 20 кадров в секунду; мигание завис — 6 с по полсекунды
const SPIN_FRAMES = 40;
const SPIN_FRAME_MS = 50;
const BLINK_FRAME_MS = 500;
const BLINK_TICKS = 12;

const isWindows = navigator.userAgent.includes('Windows');

// Значки трея i-tray-* (спецификация 2026-11-27-tauri-tray-icons.md): линия — --tray-line. На Mac 1, как у SF Symbols старого окна;
// на Windows по умолчанию 1,15 — при 16 px более тонкая линия бледнеет
const isTraySymbol = (id: string) => id.startsWith('i-tray-');

const symbolSvg = (id: string, color: string) => {
    const symbol = new DOMParser().parseFromString(icons, 'image/svg+xml').getElementById(id);
    if (!symbol) throw new Error(t('app.trayIcon.missing', { id }));
    const line = isTraySymbol(id) && !isWindows ? ' style="--tray-line: 1"' : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${symbol.getAttribute('viewBox')}" fill="${color}" color="${color}"${line}>${symbol.innerHTML}</svg>`;
};

const loadImage = (svg: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(t('app.trayIcon.drawFailed')));
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

type Frame = { rotation: number; alpha: number };

// Mac: шаблонное изображение 18 pt в два раза крупнее, цвет даст система. Windows: 16 px при 100 %, 20 при 125 %, 24 при 150 %
const renderFrames = async (icon: TrayIcon, frames: Frame[], dark: boolean) => {
    const size = isWindows ? Math.round(16 * window.devicePixelRatio) : 36;
    const color = icon.color === 'red' ? token('--red') : icon.color === 'orange' ? token('--orange') : isWindows && dark ? '#fff' : '#000';
    const isMark = icon.glyph.kind === 'mark';
    const image = await loadImage(icon.glyph.kind === 'mark' ? MARKS[icon.glyph.agent] ?? claude : symbolSvg(icon.glyph.id, '#000'));
    // Знак модели в макете — 13 px в поле 16; значки трея i-tray-* — во всё поле, поля уже внутри viewBox
    const glyph = size * (isMark ? 13 / 16 : isWindows || (icon.glyph.kind === 'icon' && isTraySymbol(icon.glyph.id)) ? 1 : 16 / 18);
    return Promise.all(
        frames.map(async ({ rotation, alpha }) => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = size;
            const context = canvas.getContext('2d')!;
            context.save();
            context.translate(size / 2, size / 2);
            context.rotate((rotation * Math.PI) / 180);
            context.drawImage(image, -glyph / 2, -glyph / 2, glyph, glyph);
            context.restore();
            context.globalCompositeOperation = 'source-in';
            context.fillStyle = color;
            context.fillRect(0, 0, size, size);
            // Числа рядом со значком на Windows не бывает: бейдж в правом нижнем углу, цифры вырезаны насквозь
            if (isWindows && icon.count > 0) {
                const text = icon.count > 99 ? '99' : String(icon.count);
                const height = Math.round(size / 2);
                const width = Math.max(height, Math.round(height * 0.45 * text.length + height * 0.5));
                context.globalCompositeOperation = 'destination-out';
                context.beginPath();
                context.roundRect(size - width - 2, size - height - 2, width + 4, height + 4, (height + 4) / 2);
                context.fill();
                context.globalCompositeOperation = 'source-over';
                context.fillStyle = color;
                context.beginPath();
                context.roundRect(size - width, size - height, width, height, height / 2);
                context.fill();
                context.globalCompositeOperation = 'destination-out';
                context.font = `700 ${Math.round(height * 0.8)}px "Segoe UI", sans-serif`;
                context.textAlign = 'center';
                context.textBaseline = 'middle';
                context.fillText(text, size - width / 2, size - height / 2 + 0.5);
            }
            context.globalCompositeOperation = 'source-over';
            context.globalAlpha = 1;
            if (alpha < 1) {
                const faded = document.createElement('canvas');
                faded.width = faded.height = size;
                const fadedContext = faded.getContext('2d')!;
                fadedContext.globalAlpha = alpha;
                fadedContext.drawImage(canvas, 0, 0);
                return toPng(faded);
            }
            return toPng(canvas);
        }),
    );
};

const toPng = (canvas: HTMLCanvasElement) =>
    new Promise<number[]>((resolve, reject) =>
        canvas.toBlob(async (blob) => (blob ? resolve([...new Uint8Array(await blob.arrayBuffer())]) : reject(new Error(t('app.trayIcon.saveFailed')))), 'image/png'),
    );

let lastIcon = '';
let lastMenu = '';

export const applyTrayIcon = async (icon: TrayIcon, tooltip: string) => {
    const dark = isWindows ? await invoke<boolean>('taskbar_dark').catch(() => true) : false;
    const key = JSON.stringify({ icon, dark, scale: window.devicePixelRatio });
    if (key !== lastIcon) {
        lastIcon = key;
        const frames: Frame[] = icon.spin
            ? Array.from({ length: SPIN_FRAMES }, (_, index) => ({ rotation: (360 * index) / SPIN_FRAMES, alpha: 1 }))
            : icon.blink
              ? [
                    { rotation: 0, alpha: 1 },
                    { rotation: 0, alpha: 0.25 },
                ]
              : [{ rotation: 0, alpha: 1 }];
        await invoke('set_tray_icon', {
            frames: await renderFrames(icon, frames, dark),
            frameMs: icon.blink ? BLINK_FRAME_MS : SPIN_FRAME_MS,
            // Мигает несколько секунд, когда зависание только обнаружено, дальше горит ровно
            maxTicks: icon.blink ? BLINK_TICKS : null,
            template: !isWindows && icon.color === 'template',
            title: !isWindows && icon.count > 0 ? String(icon.count) : null,
        }).catch(() => {
            lastIcon = '';
        });
    }
    await invoke('set_tray_tooltip', { tooltip }).catch(() => {});
};

export const applyTrayMenu = async (menu: MenuEntry[]) => {
    const key = JSON.stringify(menu);
    if (key === lastMenu) return;
    lastMenu = key;
    await invoke('set_tray_menu', { items: menu }).catch(() => {
        lastMenu = '';
    });
};
