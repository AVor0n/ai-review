import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { t } from './i18n';
import { levelsText } from './model/notifications';
import { isMuted, loadPrefs } from './model/prefs';

// Системные уведомления. Пауза — из меню по правому клику и «Настроек», что показывать — решают alerts.ts и настройки уведомлений.
// Шлёт Rust (show_notification): нажатие открывает url — PR, комментарий или тред, как в Alerts.swift
let allowed: boolean | null = null;

const ensurePermission = async () => {
    if (allowed !== null) return allowed;
    allowed = (await isPermissionGranted()) || (await requestPermission()) === 'granted';
    return allowed;
};

export type Notice = { title: string; subtitle?: string; body: string; url?: string | null };

export const notify = async ({ title, subtitle, body, url }: Notice) => {
    if (isMuted(loadPrefs())) return;
    if (await ensurePermission()) invoke('show_notification', { title, subtitle: subtitle ?? null, body, url: url ?? null }).catch(() => {});
};

type StatsEntry = { at: string; repo: string; pr: number; agent: string; pass?: string; title?: string; url?: string; findings?: Record<string, number> };

// Итог ревью модели — как в Alerts.swift: «Claude закончил ревью repo #pr», название PR и «Замечания: P1 P2×2» или «Замечаний нет»
export const reviewNotice = (entry: StatsEntry, agentName: (id: string) => string, pr?: { title: string; url: string }): Notice => {
    const levels = levelsText(entry.findings ?? {});
    return {
        title: t('alerts.review.title', { agent: agentName(entry.agent), repo: entry.repo, pr: entry.pr }),
        subtitle: pr?.title ?? entry.title ?? '',
        body: levels ? t('alerts.review.findings', { levels }) : t('alerts.review.clean'),
        url: pr?.url ?? entry.url ?? null,
    };
};
