import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { killAgents, runStructured } from './agents.mjs';
import { addToBacklog, loadBacklog, renderBacklogForPrompt, setBacklogTriage } from './backlog.mjs';
import { authorOf, buildThreads } from './comments.mjs';
import { ensureClone, fetchOrigin, resolveCommit } from './git.mjs';
import { loadMemory, renderThread } from './memory.mjs';
import { DATA_DIR, GIT_ROOT, TOOL_DIR, appendSpend, log, logError, readJson, writeJson } from './store.mjs';

// Долгие задачи бэклога: сбор из истории PR и разбор по коду (triage). Идут отдельным процессом, окно следит за ними по файлу задачи
const JOB_FILE = join(DATA_DIR, 'backlog-job.json');
// Что уже разобрано: повторный запуск на тех же данных не тратит модель
const SCAN_FILE = join(DATA_DIR, 'backlog-scan.json');
const WORK_DIR = join(DATA_DIR, 'tmp');
const WORKSPACES = join(GIT_ROOT, 'backlog-workspaces');
const LEARN_SCHEMA = join(TOOL_DIR, 'schema/backlog-learn.schema.json');
const TRIAGE_SCHEMA = join(TOOL_DIR, 'schema/backlog-triage.schema.json');
const THREADS_PER_CALL = 25;
const ITEMS_PER_CALL = 10;
const MAX_COMMENT = 3000;
// Вердикты разбора по коду, при которых запись можно закрыть
export const STALE = new Set(['fixed', 'gone', 'invalid']);
export const VERDICTS = { actual: 'актуально', fixed: 'решено', gone: 'удалено', invalid: 'не баг', unclear: 'неясно' };
export const JOB_KINDS = { learn: 'сбор из истории PR', triage: 'разбор по коду' };

const isAlive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
};

export const loadJob = () => readJson(JOB_FILE, null);
const runningJob = () => {
    const job = loadJob();
    return job?.state === 'running' && job.pid && isAlive(job.pid) ? job : null;
};
const updateJob = (patch) => writeJson(JOB_FILE, { ...loadJob(), ...patch, updatedAt: new Date().toISOString() });

export const loadScan = () => readJson(SCAN_FILE, { repos: {} });

// Окно запускает задачу и сразу возвращается: CLI в фоне повторяет ту же команду без --background
export const startInBackground = (args) => {
    const job = runningJob();
    if (job) throw new Error(`Уже идёт ${JOB_KINDS[job.kind]}`);
    spawn(process.execPath, [join(TOOL_DIR, 'src/cli.mjs'), 'backlog', ...args.filter((arg) => arg !== '--background')], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
    }).unref();
};

export const stopJob = () => {
    const job = runningJob();
    if (job) process.kill(job.pid, 'SIGTERM');
    return job;
};

const agentFor = (config) => {
    const id = config.memory?.agent ?? 'claude';
    const agent = config.agents[id];
    if (!agent) throw new Error(`memory.agent: модели ${id} нет в agents`);
    return { id, agent: { ...agent, timeoutMinutes: agent.timeoutMinutes ?? 30 } };
};

const money = (cost) => (cost ? `, $${cost.toFixed(2)}` : '');

// Обёртка задачи: один запуск за раз, ход и итог — в файле задачи, прерывание — с остановкой модели
const runJob = async (kind, repos, work) => {
    const job = runningJob();
    if (job && job.pid !== process.pid) throw new Error(`Уже идёт ${JOB_KINDS[job.kind]}`);
    writeJson(JOB_FILE, { kind, state: 'running', pid: process.pid, repos: repos.map((repo) => repo.slug), activity: null, startedAt: new Date().toISOString(), finishedAt: null, message: null, error: null });
    const abort = () => {
        killAgents();
        updateJob({ state: 'failed', activity: null, error: `${JOB_KINDS[kind]} прерван`, finishedAt: new Date().toISOString() });
        process.exit(143);
    };
    process.on('SIGTERM', abort);
    process.on('SIGINT', abort);
    mkdirSync(WORK_DIR, { recursive: true });
    let lastActivity = 0;
    const activity = (text, force = false) => {
        // Модель зовёт инструменты по несколько раз в секунду, а окно перечитывает файлы раз в пару секунд
        if (!force && Date.now() - lastActivity < 1000) return;
        lastActivity = Date.now();
        updateJob({ activity: text });
        if (process.stdout.isTTY) console.log(text);
    };
    try {
        const message = await work(activity);
        updateJob({ state: 'done', activity: null, message, finishedAt: new Date().toISOString() });
        log(`бэклог: ${JOB_KINDS[kind]} — ${message}`);
        console.log(message);
    } catch (error) {
        updateJob({ state: 'failed', activity: null, error: error.message.slice(-1500), finishedAt: new Date().toISOString() });
        logError(`бэклог: ${JOB_KINDS[kind]} упал — ${error.stack ?? error.message}`);
        throw error;
    }
};

// MARK: сбор из истории

const clip = (text) => (text.length > MAX_COMMENT ? `${text.slice(0, MAX_COMMENT)}…` : text);

// Кандидаты — незакрытые треды влитых PR: замечание оставили как есть, значит, проблему не исправили в этом PR.
// Тред с новыми комментариями после прошлого разбора — снова кандидат
const collectThreads = (pr, comments, agents, seen) =>
    buildThreads(comments)
        .map(({ root, replies }) => ({ root, thread: [root, ...replies].filter((comment) => !comment.deleted && !comment.pending).sort((a, b) => a.id - b.id) }))
        .filter(({ root, thread }) => !root.deleted && !root.pending && !root.resolution && thread[0]?.id === root.id)
        .map(({ root, thread }) => ({
            pr,
            root,
            lastId: thread.at(-1).id,
            text: renderThread(thread.map((comment) => ({ ...comment, content: { raw: clip(comment.content?.raw ?? '') } })), agents),
        }))
        .filter(({ root, lastId }) => (seen[root.id] ?? 0) < lastId);

const learnPrompt = (repo, threads) =>
    [
        `Ты собираешь бэклог технического долга репозитория \`${repo.workspace}/${repo.slug}\`. Ниже — незакрытые треды комментариев из уже влитых pull request: замечания моделей-ревьюеров и людей, которые так и не исправили в том PR.`,
        'Найди среди них реальные дефекты кода, которые остались в проекте и заслуживают отдельной задачи: команда отложила их («потом», «отдельной задачей», «было и до этого PR», «не в этом PR»), не ответила вовсе или согласилась, что проблема есть, но правку не сделала.',
        'Не бери: замечания, которые по ответам в треде исправлены («поправил», «done», «сделал») или с которыми команда не согласна по существу (так задумано, не ошибка, неважно); вопросы и обсуждения без дефекта; вкусовщину — имена, формулировки, порядок кода, стиль; детали, которые имеют смысл только внутри того PR. Если подходящих тредов нет — верни пустой список, это нормальный результат.',
        'Для каждой проблемы: `rootId` — id корня треда; `level` — P0 (авария, потеря данных), P1 (сломан основной сценарий), P2 (ошибка в частном случае), P3 (мелочь); `likelihood` — `usual` (обычный сценарий), `rare` (редкое сочетание условий), `race` (только гонка или сбой); `path` и `line` — файл и строка из треда (если их нет — пустая строка и 0); `title` — одна строка; `scenario` — когда и как проявляется; `fix` — как исправить. Пиши по-русски, коротко, с конкретными сущностями в `обратных кавычках`.',
        `Уже известные проблемы этого репозитория — не повторяй их:\n\n${renderBacklogForPrompt(repo.slug) || 'пока нет'}`,
        threads.map(({ pr, root, text }) => `### PR #${pr.id} «${pr.title ?? ''}», тред ${root.id}\n\n${text}`).join('\n\n---\n\n'),
        'Ничего не изменяй в файлах. Верни JSON по схеме.',
    ].join('\n\n');

export const learnBacklog = async ({ config, bitbucket, repos, limit, dryRun }) => {
    const scan = loadScan();
    const prepare = async (repo, activity) => {
        activity(`${repo.slug}: читаю историю PR`, true);
        const seen = scan.repos[repo.slug]?.threads ?? {};
        const prs = (await bitbucket.listRecentPrs(repo, limit)).filter((pr) => pr.state === 'MERGED' && pr.comment_count > 0);
        const threads = [];
        for (const pr of prs) threads.push(...collectThreads(pr, await bitbucket.listComments(repo, pr.id), config.agents, seen));
        return { prs, threads };
    };
    if (dryRun) {
        for (const repo of repos) {
            const { prs, threads } = await prepare(repo, () => {});
            const last = scan.repos[repo.slug]?.at;
            console.log(`${repo.slug}: влитых PR с комментариями ${prs.length}, новых незакрытых тредов ${threads.length}${last ? ` (прошлый разбор ${last})` : ''}`);
        }
        return;
    }
    return runJob('learn', repos, async (activity) => {
        const { id, agent } = agentFor(config);
        let found = 0;
        let cost = 0;
        let checked = 0;
        for (const repo of repos) {
            const { threads } = await prepare(repo, activity);
            const state = (scan.repos[repo.slug] ??= { threads: {} });
            let repoFound = 0;
            for (let start = 0; start < threads.length; start += THREADS_PER_CALL) {
                const batch = threads.slice(start, start + THREADS_PER_CALL);
                activity(`${repo.slug}: разбираю треды ${start + 1}–${start + batch.length} из ${threads.length}`, true);
                const startedAt = Date.now();
                const { data, usage } = await runStructured(id, agent, { cwd: WORK_DIR, workDir: WORK_DIR, prompt: learnPrompt(repo, batch), schemaPath: LEARN_SCHEMA });
                cost += usage.costUsd ?? 0;
                appendSpend('backlog-learn', repo.slug, id, agent, usage, startedAt);
                const byRoot = new Map(batch.map((thread) => [thread.root.id, thread]));
                for (const entry of data.items ?? []) {
                    const thread = byRoot.get(entry.rootId);
                    if (!thread) continue;
                    const author = authorOf(thread.root, config.agents);
                    const { added } = addToBacklog(
                        {
                            repo: repo.slug,
                            level: entry.level,
                            likelihood: entry.likelihood,
                            path: entry.path || thread.root.inline?.path || null,
                            line: entry.line || null,
                            title: entry.title.trim(),
                            scenario: entry.scenario.trim(),
                            fix: entry.fix.trim(),
                        },
                        {
                            pr: thread.pr.id,
                            url: thread.root.links?.html?.href ?? thread.pr.links.html.href,
                            agent: author,
                            author: author === 'human' ? (thread.root.user?.display_name ?? null) : null,
                            commit: null,
                            kind: 'history',
                        },
                    );
                    if (added) repoFound++;
                }
                // Сохраняем после каждой пачки: прерванный запуск продолжит с того же места
                for (const thread of batch) state.threads[thread.root.id] = thread.lastId;
                state.at = new Date().toISOString();
                writeJson(SCAN_FILE, scan);
            }
            checked += threads.length;
            state.at = new Date().toISOString();
            state.found = repoFound;
            writeJson(SCAN_FILE, scan);
            found += repoFound;
        }
        return checked ? `разобрано тредов ${checked}, новых проблем ${found}${money(cost)}` : 'новых обсуждений с прошлого разбора нет';
    });
};

// MARK: разбор по коду

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Свой worktree служебного клона: обычное ревью переключает сам клон на ветки PR
const ensureWorkspace = (repo, clone, commit) => {
    const dir = join(WORKSPACES, repo.slug);
    if (!existsSync(join(dir, '.git'))) {
        mkdirSync(WORKSPACES, { recursive: true });
        spawnSync('git', ['worktree', 'prune'], { cwd: clone });
        git(clone, 'worktree', 'add', '--detach', dir, commit);
    }
    git(dir, 'checkout', '--quiet', '--force', '--detach', commit);
    git(dir, 'clean', '-fdq');
    return dir;
};

const triagePrompt = (repo, branch, items, lessons) =>
    [
        `Ты проверяешь бэклог технического долга репозитория \`${repo.workspace}/${repo.slug}\`. Рабочая копия переключена на голову основной ветки \`${branch}\`. Записи бэклога сделаны раньше, по старым версиям кода: с тех пор код могли исправить, переписать или удалить.`,
        'Для каждой записи найди нужное место в текущем коде (Read, Grep, Glob; можно `git log`, `git show`, `git blame`) и реши, актуальна ли проблема:',
        '- `actual` — проблема на месте: сценарий из записи по-прежнему воспроизводится;\n- `fixed` — код изменён, и сценарий больше не приводит к ошибке;\n- `gone` — кода, о котором запись, больше нет (файл или функция удалены, механизм заменён);\n- `invalid` — проблемы не было и нет: анализ в записи ошибочен (сценарий не воспроизводится на коде, который не менялся);\n- `unclear` — по коду не понять, например проблема зависит от данных или сервера.',
        '`reason` — одно-два предложения: что ты увидел в коде (с коммитом, если нашёл исправление). `path` и `line` — где проблема сейчас (для `actual`, если место сдвинулось), иначе пустая строка и 0. Не придумывай: если не уверен, что исправлено, — это `actual` или `unclear`. Пиши по-русски.',
        lessons.length ? `Соглашения команды из прошлых ревью:\n\n${lessons.map((lesson) => `- ${lesson.text}`).join('\n')}` : null,
        `Записи:\n\n${items
            .map((item) => [`### ${item.id} · [${item.level}] ${item.title}`, `Где: \`${item.path ?? '—'}${item.line ? `:${item.line}` : ''}\``, item.scenario ? `Сценарий: ${item.scenario}` : null, item.fix ? `Исправление: ${item.fix}` : null].filter(Boolean).join('\n'))
            .join('\n\n')}`,
        'Ничего не изменяй в файлах. Верни JSON по схеме: по объекту на каждую запись, `id` — как в заголовке записи.',
    ]
        .filter(Boolean)
        .join('\n\n');

export const triageBacklog = async ({ config, bitbucket, repos, dryRun }) => {
    const open = (slug) => loadBacklog().filter((item) => item.repo === slug && item.status === 'open');
    if (dryRun) {
        for (const repo of repos) {
            const items = open(repo.slug);
            const checked = items.filter((item) => item.triage).length;
            console.log(`${repo.slug}: ждут разбора ${items.length}, уже разобрано по коду ${checked} (повторно — только если основная ветка сдвинулась)`);
        }
        return;
    }
    return runJob('triage', repos, async (activity) => {
        const { id, agent } = agentFor(config);
        let checked = 0;
        let stale = 0;
        let cost = 0;
        for (const repo of repos) {
            if (!open(repo.slug).length) continue;
            activity(`${repo.slug}: обновляю код основной ветки`, true);
            const branch = (await bitbucket.getMainBranch(repo)) ?? 'master';
            const clone = ensureClone(repo);
            fetchOrigin(clone);
            const commit = resolveCommit(clone, `origin/${branch}`);
            if (!commit) throw new Error(`${repo.slug}: в клоне нет origin/${branch}`);
            const head = commit.slice(0, 12);
            // На той же голове основной ветки ответ не изменится; новая или отредактированная запись проверяется заново
            const items = open(repo.slug).filter((item) => item.triage?.commit !== head || item.updatedAt > item.triage.at);
            if (!items.length) continue;
            const dir = ensureWorkspace(repo, clone, commit);
            const lessons = loadMemory(repo.slug);
            for (let start = 0; start < items.length; start += ITEMS_PER_CALL) {
                const batch = items.slice(start, start + ITEMS_PER_CALL);
                const prefix = `${repo.slug}: записи ${start + 1}–${start + batch.length} из ${items.length}`;
                activity(prefix, true);
                const startedAt = Date.now();
                const { data, usage } = await runStructured(id, agent, {
                    cwd: dir,
                    workDir: WORK_DIR,
                    prompt: triagePrompt(repo, branch, batch, lessons),
                    schemaPath: TRIAGE_SCHEMA,
                    onActivity: (text) => activity(`${prefix} · ${text}`),
                });
                cost += usage.costUsd ?? 0;
                appendSpend('backlog-triage', repo.slug, id, agent, usage, startedAt);
                const known = new Set(batch.map((item) => item.id));
                for (const result of data.items ?? []) {
                    if (!known.has(result.id)) continue;
                    // updatedAt не трогаем: время проверки сравнивается с ним, чтобы заметить правку записи после разбора
                    setBacklogTriage(
                        result.id,
                        { at: new Date().toISOString(), commit: head, branch, verdict: result.verdict, reason: result.reason.trim() },
                        result.verdict === 'actual' ? { path: result.path, line: result.line } : null,
                    );
                    checked++;
                    if (STALE.has(result.verdict)) stale++;
                }
            }
        }
        return checked ? `проверено записей ${checked}, похоже неактуальны ${stale}${money(cost)}` : 'нечего проверять: записи уже проверены на текущем коде';
    });
};
