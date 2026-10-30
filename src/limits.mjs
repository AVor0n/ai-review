import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR, readJson, writeJson } from './store.mjs';

// Остатки лимитов подписок для окна настроек. Адреса неофициальные — те же, что используют сами CLI:
// при сбое модель просто остаётся без строки лимита
const LIMITS_FILE = join(DATA_DIR, 'limits.json');

const save = (agent, value) => writeJson(LIMITS_FILE, { ...readJson(LIMITS_FILE, {}), [agent]: { ...value, at: new Date().toISOString() } });

const isoFromSeconds = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : null);

// Claude сообщает окна лимитов в потоке событий каждого запуска — отдельных запросов не нужно
export const rememberClaudeLimits = (event) => {
    const week = event?.rate_limit_info?.unifiedWindows?.seven_day;
    if (!week) return;
    save('claude', { window: 'week', usedPercent: Math.round(week.utilization * 1000) / 10, resetsAt: isoFromSeconds(week.resetsAt) });
};

const fetchJson = async (url, init) => {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`${response.status}`);
    return response.json();
};

// Тот же запрос, которым /status в Codex CLI показывает лимиты; токен CLI сам обновляет при каждом запуске
const codexLimits = async () => {
    const tokens = JSON.parse(readFileSync(join(homedir(), '.codex/auth.json'), 'utf8')).tokens ?? {};
    const usage = await fetchJson('https://chatgpt.com/backend-api/wham/usage', {
        headers: { Authorization: `Bearer ${tokens.access_token}`, 'ChatGPT-Account-Id': tokens.account_id ?? '', 'User-Agent': 'codex-cli' },
    });
    const window = usage.rate_limit?.primary_window;
    if (!window) return null;
    return { window: window.limit_window_seconds >= 6 * 86_400 ? 'week' : 'window', usedPercent: window.used_percent, resetsAt: isoFromSeconds(window.reset_at) };
};

// У Cursor на Pro лимит месячный и разный для «авто»-моделей (Composer и др.) и именных моделей по API
const cursorLimits = async (model) => {
    const token = execFileSync('security', ['find-generic-password', '-s', 'cursor-access-token', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const usage = await fetchJson('https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
        body: '{}',
    });
    const plan = usage.planUsage;
    if (!plan) return null;
    const auto = (usage.autoBucketModels ?? []).includes(model);
    return {
        window: 'month',
        usedPercent: Math.round((auto ? plan.autoPercentUsed : plan.apiPercentUsed) * 10) / 10,
        resetsAt: usage.billingCycleEnd ? new Date(Number(usage.billingCycleEnd)).toISOString() : null,
    };
};

export const refreshLimits = async (config) => {
    const jobs = {
        codex: config.agents.codex && codexLimits,
        cursor: config.agents.cursor && (() => cursorLimits(config.agents.cursor.model)),
    };
    const result = {};
    for (const [agent, job] of Object.entries(jobs)) {
        if (!job) continue;
        try {
            const value = await job();
            if (value) save(agent, value);
            result[agent] = value;
        } catch (error) {
            result[agent] = { error: error.message };
        }
    }
    return { ...readJson(LIMITS_FILE, {}), errors: Object.fromEntries(Object.entries(result).filter(([, value]) => value?.error)) };
};
