import { invoke } from '@tauri-apps/api/core';
import type { Schemas } from './api/client';

type Status = Schemas['Status'] & { phase?: string; running?: { repo?: string; pr?: number; agent?: string }[]; lastPassAt?: string | null };

// Значок и строка меню — как у SwiftUI (main.swift: refreshIcon, statusLine)
export const trayState = (status: Status | null, serviceDown: boolean, intervalMinutes: number) => {
    if (serviceDown || !status) return { state: 'error', tooltip: 'PR Reviewer: сервис не запущен', line: 'Сервис не запущен', paused: false };
    const running = status.running ?? [];
    const target = running[0] ? `${running[0].repo} #${running[0].pr}` : null;
    if (status.paused) return { state: 'paused', tooltip: 'PR Reviewer: фоновое ревью выключено', line: 'Фоновое ревью выключено', paused: true };
    if (status.workerRunning || running.length) {
        const line = running.length > 1 ? `Идут ${running.length} ревью` : target ? `Идёт ревью: ${target}` : 'Идёт проверка PR';
        return { state: 'running', tooltip: `PR Reviewer: ${line.toLowerCase()}`, line, paused: false };
    }
    if (status.phase === 'error') return { state: 'error', tooltip: 'PR Reviewer: последний проход завершился с ошибкой', line: 'Последний проход завершился с ошибкой', paused: false };
    const last = status.lastPassAt ? Date.parse(status.lastPassAt) : NaN;
    if (Number.isNaN(last)) return { state: 'idle', tooltip: 'PR Reviewer', line: 'Ожидание', paused: false };
    const minutes = Math.ceil((last + intervalMinutes * 60_000 - Date.now()) / 60_000);
    const line = minutes <= 1 ? 'Следующий проход в течение минуты' : `Следующий проход через ${minutes} мин`;
    return { state: 'idle', tooltip: `PR Reviewer: ${line.toLowerCase()}`, line, paused: false };
};

export const applyTray = (tray: ReturnType<typeof trayState>) =>
    invoke('set_tray_state', { state: tray.state, tooltip: tray.tooltip, statusLine: tray.line, paused: tray.paused }).catch(() => {});
