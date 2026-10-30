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
    if (!response.ok) throw Object.assign(new Error(`${response.status}`), { status: response.status });
    return response.json();
};

// Тот же запрос, которым /status в Codex CLI показывает лимиты; токен CLI сам обновляет при каждом запуске
const codexLimits = async () => {
    let tokens;
    try {
        tokens = JSON.parse(readFileSync(join(homedir(), '.codex/auth.json'), 'utf8')).tokens ?? {};
    } catch {
        throw new Error('нет входа Codex (codex login)');
    }
    const usage = await fetchJson('https://chatgpt.com/backend-api/wham/usage', {
        headers: { Authorization: `Bearer ${tokens.access_token}`, 'ChatGPT-Account-Id': tokens.account_id ?? '', 'User-Agent': 'codex-cli' },
    });
    const window = usage.rate_limit?.primary_window;
    if (!window) return null;
    return { window: window.limit_window_seconds >= 6 * 86_400 ? 'week' : 'window', usedPercent: window.used_percent, resetsAt: isoFromSeconds(window.reset_at) };
};

// Токен входа Cursor (cursor-access-token) живёт час и обновляется, только когда запускается сам CLI,
// поэтому каждый опрос сам обменивает API-ключ на свежий токен — тем же запросом, что делает cursor-agent
const cursorToken = async (keychainService) => {
    let key;
    try {
        key = execFileSync('security', ['find-generic-password', '-s', keychainService, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        throw new Error(`нет API-ключа в Keychain (${keychainService})`);
    }
    const { accessToken } = await fetchJson('https://api2.cursor.sh/auth/exchange_user_api_key', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: '{}',
    });
    if (!accessToken) throw new Error('Cursor не выдал токен по API-ключу');
    return accessToken;
};

// У Cursor на Pro лимит месячный и разный для «авто»-моделей (Composer и др.) и именных моделей по API
const cursorLimits = async ({ model, keychainService = 'pr-reviewer-cursor' }) => {
    const token = await cursorToken(keychainService);
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

// Коротко для окна: оно пишет «ошибка 401, нет доступа» или «сервер не ответил»
const describeError = (error) => {
    if (error.status) return { code: error.status, text: [401, 403].includes(error.status) ? 'нет доступа' : `ошибка ${error.status}` };
    if (error.name === 'TimeoutError') return { code: null, text: 'сервер не ответил' };
    return { code: null, text: error.message };
};

// Прошлый остаток не стирается: окно показывает его с пометкой, что он не обновляется. Успешный опрос (save) убирает ошибку.
// Без прошлого остатка запись не создаём — окну нечего показывать, кроме «лимит недоступен»
const saveError = (agent, error) => {
    const limits = readJson(LIMITS_FILE, {});
    if (!limits[agent]) return;
    writeJson(LIMITS_FILE, { ...limits, [agent]: { ...limits[agent], error: describeError(error), errorAt: new Date().toISOString() } });
};

export const refreshLimits = async (config) => {
    const jobs = {
        codex: config.agents.codex && codexLimits,
        cursor: config.agents.cursor && (() => cursorLimits(config.agents.cursor)),
    };
    const result = {};
    for (const [agent, job] of Object.entries(jobs)) {
        if (!job) continue;
        try {
            const value = await job();
            if (value) save(agent, value);
            result[agent] = value;
        } catch (error) {
            saveError(agent, error);
            result[agent] = { error: error.message };
        }
    }
    return { ...readJson(LIMITS_FILE, {}), errors: Object.fromEntries(Object.entries(result).filter(([, value]) => value?.error)) };
};
