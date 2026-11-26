import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useRef, useState, type WheelEvent } from 'react';
import { createApi, type ApiClient } from '../api/client';
import { Icon } from '../components/Icon';
import { t, useLang } from '../i18n';
import { formatNumber } from '../model/format';
import { fileName, isVideo, mediaUrl, parseViewerQuery, type ViewerRequest } from './media';

// Окно просмотра скриншотов и видео прогона — перенос QaMediaWindow и QaMediaBrowser из menubar/QaViews.swift.
// Отдельное окно Tauri: картинка вписана в окно, щипок или двойной клик — масштаб; видео играет сразу, скорость общая для всех видео
const RATES = [0.5, 1, 1.5, 2];
const RATE_KEY = 'pr-reviewer.viewerRate';
const isWindows = navigator.userAgent.includes('Windows');

const loadRate = () => {
    try {
        const value = Number(localStorage.getItem(RATE_KEY));
        return RATES.includes(value) ? value : 1;
    } catch {
        return 1;
    }
};

const rateTitle = (rate: number) => `${formatNumber(rate)}×`;

export const Viewer = ({ initial }: { initial: string }) => {
    const [request, setRequest] = useState<ViewerRequest | null>(() => parseViewerQuery(initial));
    const [api, setApi] = useState<ApiClient | null>(null);
    const [url, setUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    // null — вписано в окно; число — масштаб, который выбрал человек
    const [scale, setScale] = useState<number | null>(null);
    const [rate, setRate] = useState(loadRate);
    const video = useRef<HTMLVideoElement>(null);
    const image = useRef<HTMLImageElement>(null);
    const lang = useLang();

    useEffect(() => {
        invoke<string>('api_token').then((token) => setApi(createApi(token)), (reason) => setError(String(reason)));
        const unlisten = listen<string>('viewer-files', ({ payload }) => setRequest(parseViewerQuery(payload)));
        return () => {
            unlisten.then((stop) => stop());
        };
    }, []);

    const path = request?.files[request.index];
    useEffect(() => {
        if (!request || !path) return;
        getCurrentWindow()
            .setTitle(t('qa.viewer.windowTitle', { file: fileName(path), index: request.index + 1, total: request.files.length }))
            .catch(() => {});
    }, [request, path, lang]);

    useEffect(() => {
        setUrl(null);
        setScale(null);
        setError(null);
        if (!api || !request || !path) return;
        mediaUrl(api, request.repo, request.pr, path).then(setUrl, (reason) => setError(String(reason?.message ?? reason)));
    }, [api, request, path]);

    useEffect(() => {
        if (video.current) video.current.playbackRate = rate;
        try {
            localStorage.setItem(RATE_KEY, String(rate));
        } catch {
            // Без хранилища скорость живёт до закрытия окна
        }
    }, [rate, url]);

    const go = (delta: number) => setRequest((current) => (current ? { ...current, index: Math.min(Math.max(current.index + delta, 0), current.files.length - 1) } : current));
    // Закрытие окна останавливает видео: окно уничтожается вместе со страницей
    const close = () => getCurrentWindow().close();
    const fullPath = request && path ? `${request.runDir}/${path}` : null;

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'ArrowLeft') go(-1);
            if (event.key === 'ArrowRight') go(1);
            if (event.key === 'Escape') close();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    // Двойной клик: из «по размеру окна» — в 1:1, из увеличенного — обратно по размеру окна
    const toggleZoom = () => setScale((current) => (current === null || current < 0.99 ? 1 : null));
    // Щипок на тачпаде приходит в WebKit колесом с Ctrl
    const pinch = (event: WheelEvent) => {
        if (!event.ctrlKey || !image.current) return;
        event.preventDefault();
        const fit = Math.min(image.current.parentElement!.clientWidth / image.current.naturalWidth, image.current.parentElement!.clientHeight / image.current.naturalHeight, 1);
        setScale((current) => Math.min(8, Math.max(0.05, (current ?? fit) * Math.exp(-event.deltaY / 100))));
    };

    const video_ = path ? isVideo(path) : false;
    return (
        <div className="app viewer">
            <div className="viewer__stage" onWheel={pinch}>
                {error && <span className="viewer__hint">{error}</span>}
                {url &&
                    (video_ ? (
                        <video ref={video} src={url} autoPlay controls onLoadedMetadata={(event) => (event.currentTarget.playbackRate = rate)} />
                    ) : (
                        <img
                            ref={image}
                            src={url}
                            alt={path ? fileName(path) : ''}
                            onDoubleClick={toggleZoom}
                            style={scale === null ? { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', width: 'auto', height: 'auto' } : { width: (image.current?.naturalWidth ?? 0) * scale, maxWidth: 'none', maxHeight: 'none' }}
                        />
                    ))}
            </div>
            <div className="viewer__bar">
                <button className="square-button" title={t('qa.viewer.previous')} disabled={!request || request.index <= 0} onClick={() => go(-1)}>
                    <Icon id="i-chevron-left" />
                </button>
                <button className="square-button" title={t('qa.viewer.next')} disabled={!request || request.index >= request.files.length - 1} onClick={() => go(1)}>
                    <Icon id="i-chevron-right" />
                </button>
                {video_ ? (
                    <div className="segmented" style={{ '--segment-width': '48px' } as React.CSSProperties} title={t('qa.viewer.speed')}>
                        {RATES.map((value) => (
                            <button key={value} className="segmented__item" aria-selected={rate === value} onClick={() => setRate(value)}>
                                {rateTitle(value)}
                            </button>
                        ))}
                    </div>
                ) : (
                    <span className="viewer__hint">{t('qa.viewer.zoomHint')}</span>
                )}
                <span className="spacer" />
                {fullPath && (
                    <>
                        <button className="button" onClick={() => invoke('reveal_path', { path: fullPath }).catch(() => {})}>
                            {isWindows ? t('qa.viewer.revealExplorer') : t('qa.viewer.revealFinder')}
                        </button>
                        <button className="button" onClick={() => invoke('open_path', { path: fullPath }).catch(() => {})}>
                            {isWindows ? t('qa.viewer.openDefault') : video_ ? t('qa.viewer.openOther') : t('qa.viewer.openPreview')}
                        </button>
                    </>
                )}
                <button className="button" onClick={close}>
                    {t('common.action.close')}
                </button>
            </div>
        </div>
    );
};
