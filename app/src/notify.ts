import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { isMuted, loadPrefs } from './model/prefs';

// Системные уведомления. Пауза — из меню по правому клику; настройки по видам появятся вместе с экраном настроек
let allowed: boolean | null = null;

const ensurePermission = async () => {
    if (allowed !== null) return allowed;
    allowed = (await isPermissionGranted()) || (await requestPermission()) === 'granted';
    return allowed;
};

export const notify = async (title: string, body: string) => {
    if (isMuted(loadPrefs())) return;
    if (await ensurePermission()) sendNotification({ title, body });
};

type StatsEntry = { at: string; repo: string; pr: number; agent: string; pass?: string; findings?: Record<string, number> };

// Итог ревью модели — как в Alerts.swift: «Claude закончил ревью repo #pr» и замечания по уровням
export const reviewNotice = (entry: StatsEntry, agentName: (id: string) => string) => {
    const levels = Object.entries(entry.findings ?? {})
        .filter(([, count]) => count)
        .map(([level, count]) => `${level}: ${count}`);
    return { title: `${agentName(entry.agent)} закончил ревью ${entry.repo} #${entry.pr}`, body: levels.length ? `Замечания ${levels.join(', ')}` : 'Замечаний нет' };
};
