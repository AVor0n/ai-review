import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { rememberClaudeLimits } from './limits.mjs';
import { GIT_ROOT, log, logError, TOOL_DIR } from './store.mjs';

const REVIEW_SCHEMA = join(TOOL_DIR, 'schema/review.schema.json');
const running = new Set();

// Модель запускает свои подпроцессы (git, rg), поэтому убиваем всю группу, а не только CLI
const killGroup = (child) => {
    try {
        process.kill(-child.pid, 'SIGTERM');
    } catch {
        // процесс уже завершился
    }
};

export const killAgents = () => {
    for (const child of running) killGroup(child);
};

// Токены CLI — в Keychain: у Claude это `claude setup-token` (обычная OAuth-сессия в фоне протухает), у Cursor — API-ключ
const readKeychain = (keychainService) => {
    try {
        return execFileSync('security', ['find-generic-password', '-s', keychainService, '-w'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return null;
    }
};

const runProcess = (command, args, { cwd, input, timeoutMs, env, unset = [], onLine }) =>
    new Promise((resolve, reject) => {
        const fullEnv = { ...process.env, ...env };
        for (const name of unset) delete fullEnv[name];
        const child = spawn(command, args, { cwd, env: fullEnv, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
        running.add(child);
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let pending = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
            if (!onLine) return;
            pending += chunk;
            const lines = pending.split('\n');
            pending = lines.pop();
            for (const line of lines) onLine(line);
        });
        child.stderr.on('data', (chunk) => (stderr += chunk));
        const timer = setTimeout(() => {
            timedOut = true;
            // Только свой вызов: в том же процессе идут ревью других репозиториев
            killGroup(child);
        }, timeoutMs);
        child.on('error', reject);
        child.on('close', (code) => {
            clearTimeout(timer);
            running.delete(child);
            if (code === 0) resolve(stdout);
            else if (timedOut) reject(new Error(`${command}: превышен таймаут ${Math.round(timeoutMs / 60000)} мин`));
            else reject(new Error(`${command} завершился с кодом ${code}: ${stderr.slice(-800) || stdout.slice(-800)}`));
        });
        child.stdin.end(input);
    });

// Тариф выбранной модели: id в Cursor несут уровень и режим (grok-4.7-high-fast), поэтому ищется самый длинный
// ключ-префикс, а у -fast — его отдельный тариф «<ключ>-fast»: быстрый режим в разы дороже обычного
export const tariffFor = (agent, model = agent.model ?? '') => {
    const table = agent.modelPricing ?? {};
    const fast = model.endsWith('-fast');
    const base = fast ? model.slice(0, -'-fast'.length) : model;
    const key = Object.keys(table)
        .filter((candidate) => !candidate.endsWith('-fast') && (base === candidate || base.startsWith(`${candidate}-`)))
        .sort((a, b) => b.length - a.length)[0];
    if (key) return table[fast ? `${key}-fast` : key] ?? null;
    return agent.pricing ?? null;
};

// Цена по ценам из config (за миллион токенов) — для моделей, чей CLI сам её не сообщает
const priced = (agent, usage) => {
    const pricing = tariffFor(agent);
    if (!pricing) return null;
    const fresh = usage.inputTokens - usage.cachedTokens;
    const total = fresh * pricing.inputPerMTok + usage.cachedTokens * (pricing.cachedInputPerMTok ?? pricing.inputPerMTok) + usage.outputTokens * pricing.outputPerMTok;
    return Math.round(total / 1e4) / 100;
};

const parseLoose = (text) => {
    const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    return JSON.parse(trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1));
};

const REVIEW_TOOLS = {
    tools: 'Read,Grep,Glob,Bash',
    allowedTools: 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git blame:*)',
    permissionMode: 'dontAsk',
};

// Строка о том, что модель делает сейчас, — для окна хода доработки
const describeTool = ({ name, input = {} }, cwd) => {
    const file = (path) => {
        const inside = path ? relative(cwd, path) : '';
        return inside && !inside.startsWith('..') ? inside : path ?? '';
    };
    const short = (text, max = 90) => (text.length > max ? `${text.slice(0, max)}…` : text);
    switch (name) {
        case 'Read': return `читает ${file(input.file_path)}`;
        case 'Edit':
        case 'MultiEdit':
        case 'Write': return `правит ${file(input.file_path)}`;
        case 'Grep': return `ищет «${short(input.pattern ?? '', 50)}»`;
        case 'Glob': return `ищет файлы ${input.pattern ?? ''}`;
        case 'Bash': return `запускает ${short((input.command ?? '').split('\n')[0])}`;
        case 'StructuredOutput': return 'готовит отчёт';
        default: return name;
    }
};

const parseLine = (line) => {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
};

const streamActivity = (cwd, onActivity) => (line) => {
    const event = parseLine(line);
    if (event?.type === 'rate_limit_event') rememberClaudeLimits(event);
    if (event?.type !== 'assistant' || !onActivity) return;
    for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') onActivity(describeTool(block, cwd));
    }
};

// access — набор инструментов и режим разрешений; по умолчанию только чтение, как для ревью.
// onActivity — колбэк для долгих запусков: по потоку событий видно, что делает модель
const runClaude = async (agent, { cwd, prompt, schemaPath, access = REVIEW_TOOLS, onActivity }) => {
    const token = agent.keychainService ? readKeychain(agent.keychainService) : null;
    const output = await runProcess(
        'claude',
        [
            '-p',
            '--model', agent.model,
            ...(agent.effort ? ['--effort', agent.effort] : []),
            // Поток событий и для ревью: в нём же приходят остатки лимитов подписки
            '--output-format', 'stream-json', '--verbose',
            '--json-schema', readFileSync(schemaPath, 'utf8'),
            // --restricted не читает пользовательские и проектные settings: ни хуков, ни уведомлений
            '--restricted',
            '--strict-mcp-config',
            '--no-session-persistence',
            '--disable-slash-commands',
            '--tools', access.tools,
            '--allowedTools', access.allowedTools,
            ...(access.disallowedTools ? ['--disallowedTools', access.disallowedTools] : []),
            '--permission-mode', access.permissionMode,
        ],
        {
            cwd,
            input: prompt,
            timeoutMs: agent.timeoutMinutes * 60_000,
            env: token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {},
            onLine: streamActivity(cwd, onActivity),
        },
    ).catch((error) => {
        const reason = /"result":"([^"]+)"/.exec(error.message)?.[1];
        throw reason ? new Error(`claude: ${reason}`) : error;
    });
    // В потоке итог — событие result, после него могут идти служебные события
    const result = output.split('\n').map(parseLine).findLast((event) => event?.type === 'result');
    if (!result) throw new Error('claude: в потоке нет итогового события');
    if (result.is_error) throw new Error(`claude: ${result.result ?? result.subtype}`);
    const tokens = result.usage ?? {};
    const cachedTokens = tokens.cache_read_input_tokens ?? 0;
    const usage = {
        // У Anthropic input_tokens не включает кэш, приводим к общей сумме, как у OpenAI
        inputTokens: (tokens.input_tokens ?? 0) + cachedTokens + (tokens.cache_creation_input_tokens ?? 0),
        cachedTokens,
        outputTokens: tokens.output_tokens ?? 0,
    };
    // С токеном подписки это цена по тарифам API, а не реальное списание
    usage.costUsd = result.total_cost_usd ?? priced(agent, usage);
    return { data: result.structured_output ?? parseLoose(result.result), usage };
};

const codexUsage = (agent, events) => {
    const usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
    for (const line of events.split('\n')) {
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            continue;
        }
        if (event.type !== 'turn.completed' || !event.usage) continue;
        usage.inputTokens += event.usage.input_tokens ?? 0;
        usage.cachedTokens += event.usage.cached_input_tokens ?? 0;
        usage.outputTokens += event.usage.output_tokens ?? 0;
    }
    return { ...usage, costUsd: priced(agent, usage) };
};

const runCodex = async (agent, { cwd, prompt, workDir, schemaPath }) => {
    const outputFile = join(workDir, 'codex-last-message.json');
    rmSync(outputFile, { force: true });
    const events = await runProcess(
        'codex',
        [
            'exec',
            // В stdout идут события JSONL — из них берём расход токенов
            '--json',
            // Без пользовательского config.toml не поднимаются MCP-серверы и не тратятся токены на их схемы
            '--ignore-user-config',
            '--ephemeral',
            '--color', 'never',
            '-m', agent.model,
            '-c', `model_reasoning_effort="${agent.reasoningEffort}"`,
            '-s', 'read-only',
            '-C', cwd,
            '--output-schema', schemaPath,
            '-o', outputFile,
            '-',
        ],
        { cwd, input: prompt, timeoutMs: agent.timeoutMinutes * 60_000 },
    );
    return { data: parseLoose(readFileSync(outputFile, 'utf8')), usage: codexUsage(agent, events) };
};

// Cursor CLI подхватывает из домашней папки хуки (~/.cursor/hooks.json и даже ~/.claude/settings.json), правила и MCP,
// а флага изоляции у него нет. Поэтому запускаем его с отдельной домашней папкой; Keychains пробрасываем ссылкой —
// без них CLI падает даже с API-ключом
const CURSOR_HOME = join(GIT_ROOT, 'cursor-home');

const cursorHome = () => {
    const keychains = join(CURSOR_HOME, 'Library', 'Keychains');
    if (!existsSync(keychains)) {
        mkdirSync(join(CURSOR_HOME, 'Library'), { recursive: true });
        symlinkSync(join(homedir(), 'Library', 'Keychains'), keychains);
    }
    return CURSOR_HOME;
};

const CHAT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Свежесть чата — по самому новому файлу внутри: SQLite дописывает store.db, не меняя mtime папки
const scanDir = (dir) => {
    let newest = statSync(dir).mtimeMs;
    let bytes = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            const inner = scanDir(path);
            newest = Math.max(newest, inner.newest);
            bytes += inner.bytes;
        } else {
            const stat = statSync(path);
            newest = Math.max(newest, stat.mtimeMs);
            bytes += stat.size;
        }
    }
    return { newest, bytes };
};

// Cursor сохраняет каждый запуск в .cursor/chats/<проект>/<чат> (~1,5 МБ) и сам их не удаляет.
// Чат идущего запуска свежий и под отсечку не попадает
const pruneCursorChats = () => {
    const root = join(CURSOR_HOME, '.cursor', 'chats');
    if (!existsSync(root)) return;
    const cutoff = Date.now() - CHAT_TTL_MS;
    let removed = 0;
    let freed = 0;
    try {
        for (const project of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
            const projectDir = join(root, project.name);
            for (const chat of readdirSync(projectDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
                const chatDir = join(projectDir, chat.name);
                try {
                    const { newest, bytes } = scanDir(chatDir);
                    if (newest >= cutoff) continue;
                    rmSync(chatDir, { recursive: true, force: true });
                    removed += 1;
                    freed += bytes;
                } catch (error) {
                    // Чат мог удалить параллельный запуск Cursor из другого процесса
                    if (error.code !== 'ENOENT') throw error;
                }
            }
            if (readdirSync(projectDir).length === 0) rmSync(projectDir, { recursive: true, force: true });
        }
    } catch (error) {
        logError(`cursor: не удалось очистить старые чаты: ${error.message}`);
    }
    if (removed > 0) log(`cursor: удалено чатов старше недели — ${removed}, освобождено ${Math.round(freed / 1024 / 1024)} МБ`);
};

const PROXY_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'ALL_PROXY', 'all_proxy'];

const describeCursorTool = (call, cwd) => {
    const [kind, body] = Object.entries(call ?? {})[0] ?? [];
    const args = body?.args ?? {};
    const file = (path) => {
        const inside = path ? relative(cwd, path) : '';
        return inside && !inside.startsWith('..') ? inside : path ?? '';
    };
    switch (kind) {
        case 'readToolCall': return `читает ${file(args.path)}`;
        case 'grepToolCall': return `ищет «${(args.pattern ?? '').slice(0, 50)}»`;
        case 'globToolCall': return `ищет файлы ${args.globPattern ?? ''}`;
        case 'lsToolCall': return `смотрит ${file(args.path)}`;
        case 'shellToolCall': return `запускает ${(args.command ?? '').split('\n')[0].slice(0, 90)}`;
        default: return kind?.replace(/ToolCall$/, '') ?? 'работает';
    }
};

const cursorUsage = (agent, result) => {
    const tokens = result.usage ?? {};
    const cachedTokens = tokens.cacheReadTokens ?? 0;
    const usage = {
        inputTokens: (tokens.inputTokens ?? 0) + cachedTokens + (tokens.cacheWriteTokens ?? 0),
        cachedTokens,
        outputTokens: tokens.outputTokens ?? 0,
    };
    // Cursor списывает по подписке и цену не сообщает; оценка — только если в config заданы тарифы
    return { ...usage, costUsd: priced(agent, usage) };
};

const addUsage = (a, b) => ({
    inputTokens: a.inputTokens + b.inputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd === null || b.costUsd === null ? null : a.costUsd + b.costUsd,
});

const cursorOnce = async (agent, { cwd, prompt, onActivity }) => {
    const key = agent.keychainService ? readKeychain(agent.keychainService) : null;
    if (!key) throw new Error(`cursor: нет API-ключа в Keychain (${agent.keychainService})`);
    pruneCursorChats();
    const output = await runProcess(
        'cursor-agent',
        // ask — режим только для чтения; MCP без --approve-mcps не поднимаются
        ['-p', '--output-format', 'stream-json', '--mode', 'ask', '--trust', '--model', agent.model, '--workspace', cwd],
        {
            cwd,
            input: prompt,
            timeoutMs: agent.timeoutMinutes * 60_000,
            env: { HOME: cursorHome(), CURSOR_API_KEY: key },
            // Прокси из окружения сессии Claude Code медленный и рвёт соединения Cursor
            unset: PROXY_VARS,
            onLine: onActivity && ((line) => {
                const event = parseLine(line);
                if (event?.type === 'tool_call' && event.subtype === 'started') onActivity(describeCursorTool(event.tool_call, cwd));
            }),
        },
    );
    const result = output.split('\n').map(parseLine).findLast((event) => event?.type === 'result');
    if (!result) throw new Error('cursor: в потоке нет итогового события');
    if (result.is_error) throw new Error(`cursor: ${result.result ?? result.subtype}`);
    return { text: result.result ?? '', usage: cursorUsage(agent, result) };
};

// Строки вида «grok-4.7-high - Grok 4.7  High»; auto — выбор модели самим Cursor, для ревью он непредсказуем
export const listCursorModels = async (agent) => {
    const key = readKeychain(agent?.keychainService ?? 'pr-reviewer-cursor');
    if (!key) throw new Error('Нет API-ключа Cursor в Keychain (pr-reviewer-cursor)');
    const output = await runProcess('cursor-agent', ['models'], {
        cwd: cursorHome(),
        input: '',
        timeoutMs: 60_000,
        env: { HOME: cursorHome(), CURSOR_API_KEY: key },
        unset: PROXY_VARS,
    });
    return output
        .split('\n')
        .map((line) => /^(\S+) - (.+?)(?:\s+\((?:current|default)[^)]*\))?$/.exec(line.trim()))
        .filter((match) => match && match[1] !== 'auto')
        .map((match) => ({ id: match[1], title: match[2].replace(/\s+/g, ' ').replace(/[\u200b]/g, '').trim() }));
};

// У Cursor CLI нет флага схемы ответа: схема идёт в промпт, а невалидный JSON получает одну попытку исправиться
const runCursor = async (agent, { cwd, prompt, schemaPath, onActivity }) => {
    const schema = readFileSync(schemaPath, 'utf8');
    const instruction = `\n\nОтвет — только JSON-объект по этой JSON Schema, без markdown-обёртки и текста вокруг:\n\n${schema}`;
    const first = await cursorOnce(agent, { cwd, prompt: prompt + instruction, onActivity });
    try {
        return { data: parseLoose(first.text), usage: first.usage };
    } catch {
        const retry = await cursorOnce(agent, {
            cwd,
            prompt: `Ниже твой прошлый ответ на задачу ревью — он не разбирается как JSON. Верни те же данные строго JSON-объектом по схеме, без текста вокруг.\n\nПрошлый ответ:\n\n${first.text}${instruction}`,
            onActivity,
        });
        return { data: parseLoose(retry.text), usage: addUsage(first.usage, retry.usage) };
    }
};

const RUNNERS = { claude: runClaude, codex: runCodex, cursor: runCursor };

export { priced };

export const runStructured = (agentId, agent, options) => RUNNERS[agentId](agent, options);

export const runAgent = async (agentId, agent, options) => {
    const { data, usage } = await RUNNERS[agentId](agent, { ...options, schemaPath: REVIEW_SCHEMA });
    if (!Array.isArray(data?.findings) || !Array.isArray(data?.replies)) {
        throw new Error(`${agentId}: ответ не соответствует схеме`);
    }
    // Поле появилось позже остальных; модель, которая его не вернула, просто ничего не закрывает
    if (!Array.isArray(data.resolutions)) data.resolutions = [];
    if (!Array.isArray(data.appliedLessons)) data.appliedLessons = [];
    return { data, usage };
};
