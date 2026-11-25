import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { killAgents, listCursorModels } from './agents.mjs';
import { archWorker, listArchStates, loadArchState, renderArchReport, requestArch, stopArch } from './arch.mjs';
import { STATUSES, itemPlace, loadBacklog, renderBacklog, setBacklogStatus } from './backlog.mjs';
import { QA_STATES, listQaStates, loadQaState, qaSettings, qaWorker, renderQaPlan, renderQaReport, requestQaPlan, requestQaRun, saveQaTests, stopQa } from './qa.mjs';
import { STALE, VERDICTS, learnBacklog, startInBackground, stopJob, triageBacklog } from './backlog-jobs.mjs';
import { cloneDir, isCloned } from './git.mjs';
import { createBitbucket } from './bitbucket.mjs';
import { fixWorker, requestFix, stopFix } from './fix.mjs';
import { addLesson, collectFeedback, learn, loadMemory, removeLesson, updateLesson } from './memory.mjs';
import { applyMemoryPlan, discardMemoryPlan, isPlanOutdated, lessonUsage, loadMemoryPlan, renderMemoryHistory, renderMemoryPlan, restoreMemory, reviewMemory, usageLine } from './memory-review.mjs';
import { loadMemoryHistory } from './memory.mjs';
import { GENERAL, addTag, initSelection, loadSelection, retagLessons } from './rule-selection.mjs';
import { renderSelectionReport, selectionReport } from './rule-selection-report.mjs';
import { addRepo, cloneRepo, listRepos, pruneMissingSources, removeRepo, setRepoPaused } from './repos.mjs';
import { runPool } from './pool.mjs';
import { reviewRepo, reviewRequested } from './review.mjs';
import { refreshSnapshot } from './snapshot.mjs';
import { refreshLimits } from './limits.mjs';
import { formatStats } from './stats.mjs';
import { keepAwake, kickstartWorker, readSecret, writeSecret } from './platform.mjs';
import { exportData, importData } from './transfer.mjs';
import {
    DATA_DIR,
    acquireLock,
    clearQueue,
    dequeueReview,
    enqueueReview,
    isPaused,
    listQueue,
    loadConfig,
    loadOutcomes,
    loadState,
    loadStats,
    loadStatus,
    log,
    saveConfig,
    logError,
    readWorkerPid,
    onStopRequest,
    releaseLock,
    requestRun,
    requestStop,
    rotateLog,
    saveState,
    setRunning,
    setPaused,
    takeRunRequest,
    writeJson,
    updateStatus,
} from './store.mjs';

const [command = 'help', ...args] = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
};


const STOP_FILE = join(DATA_DIR, 'stop-requested');


// Заявки из окна обзора; новые могут прийти, пока идёт ревью, поэтому читаем очередь до опустошения
// slug — только заявки этого репозитория: их разбирает его дорожка, не дожидаясь чужих репозиториев
const drainQueue = async (ctx, slug = null) => {
    const pending = () => listQueue().filter((request) => !slug || request.repo === slug);
    for (let queue = pending(); queue.length; queue = pending()) {
        const bySlug = Map.groupBy(queue, (request) => request.repo);
        for (const [repoSlug, requests] of bySlug) {
            const repo = ctx.config.repos.find((candidate) => candidate.slug === repoSlug);
            try {
                if (repo) await reviewRequested(ctx, repo, requests);
                else log(`${repoSlug}: репозиторий не подключён, заявки сняты`);
            } catch (error) {
                ctx.errors.push(`${repoSlug}: ${error.message}`);
                logError(`${repoSlug}: ${error.stack ?? error.message}`);
            } finally {
                // Снимаем и после ошибки: иначе сломанная заявка зациклила бы воркер
                requests.forEach(dequeueReview);
            }
        }
    }
};


// Небольшой допуск: launchd будит раз в минуту, и без него проход при интервале 15 мин сползал бы на 16-ю минуту
const INTERVAL_TOLERANCE_MS = 30_000;

const isPassDue = (intervalMinutes) => {
    const lastPassAt = Date.parse(loadStatus().lastPassAt ?? '');
    return !lastPassAt || Date.now() - lastPassAt >= intervalMinutes * 60_000 - INTERVAL_TOLERANCE_MS;
};

const run = async () => {
    const dryRun = hasFlag('--dry-run');
    // launchd будит воркер раз в минуту с --scheduled, а интервал из config решает, пора ли фоновому проходу:
    // так интервал меняется на лету, без перезагрузки launchd и без прерывания идущего ревью
    const scheduled = hasFlag('--scheduled');
    const config = pruneMissingSources();
    const due = !scheduled || takeRunRequest() || isPassDue(config.intervalMinutes ?? 15);
    // Явные заявки выполняем и на паузе: пауза останавливает только фоновый обход
    const automatic = due && (!isPaused() || dryRun || hasFlag('--force'));
    if (!automatic && !listQueue().length) {
        if (!scheduled) log('на паузе, запуск пропущен');
        return;
    }
    if (!acquireLock()) {
        if (!scheduled) log('предыдущий запуск ещё идёт');
        return;
    }
    rotateLog();
    // Пульс для окна: git в сервисе синхронный и при зависании блокирует процесс целиком — пульс останавливается,
    // а работа моделей асинхронная и пульсу не мешает. Окно считает проход зависшим через 15 минут без пульса
    const beat = () => !dryRun && writeFileSync(join(DATA_DIR, 'heartbeat'), new Date().toISOString());
    beat();
    setInterval(beat, 30_000).unref();

    const state = loadState();
    const ctx = {
        config,
        state,
        dryRun,
        onlyPr: option('--pr') ? Number(option('--pr')) : null,
        errors: [],
        workDir: join(DATA_DIR, 'tmp'),
        save: () => !dryRun && saveState(state),
        setCurrent: (current) => !dryRun && setRunning(current.repo, current),
    };
    mkdirSync(ctx.workDir, { recursive: true });
    // Не даём маку уснуть по бездействию посреди ревью; caffeinate завершится вместе с процессом
    keepAwake();

    const abort = () => {
        killAgents();
        if (!dryRun) updateStatus({ phase: 'idle', current: null, running: [], lastError: 'ревью прервано' });
        releaseLock();
        process.exit(143);
    };
    process.on('SIGTERM', abort);
    process.on('SIGINT', abort);
    onStopRequest(STOP_FILE, abort);

    const startedAt = new Date().toISOString();
    if (!dryRun) updateStatus({ phase: 'running', current: null, running: [], lastStartAt: startedAt, ...(automatic ? { lastPassAt: startedAt } : {}) });
    try {
        ctx.bitbucket = createBitbucket(config.bitbucket);
        const repos = automatic ? config.repos.filter((repo) => !option('--repo') || repo.slug === option('--repo')) : [];
        const queued = new Set(dryRun ? [] : listQueue().map((request) => request.repo));
        const lanes = config.repos.filter((repo) => repos.includes(repo) || queued.has(repo.slug));
        // Репозитории идут параллельно, внутри репозитория — по очереди. У каждой дорожки свой workDir:
        // в нём файлы ответа моделей, которые иначе перезаписывали бы друг друга
        await runPool(lanes, Math.max(1, config.parallelRepos ?? 3), async (repo) => {
            const lane = { ...ctx, workDir: join(ctx.workDir, repo.slug) };
            mkdirSync(lane.workDir, { recursive: true });
            try {
                if (!dryRun) await drainQueue(lane, repo.slug);
                if (repos.includes(repo)) await reviewRepo(lane, repo);
                if (!dryRun) await drainQueue(lane, repo.slug);
            } catch (error) {
                ctx.errors.push(`${repo.slug}: ${error.message}`);
                logError(`${repo.slug}: ${error.stack ?? error.message}`);
            } finally {
                if (!dryRun) setRunning(repo.slug, null);
            }
        });
        // Заявки, пришедшие в конце, и заявки на неподключённые репозитории
        if (!dryRun) await drainQueue(ctx);
    } catch (error) {
        ctx.errors.push(error.message);
        logError(error.message);
    } finally {
        const lastError = ctx.errors[0] ?? null;
        if (!dryRun) {
            state.errorStreak = lastError ? (state.errorStreak ?? 0) + 1 : 0;
            saveState(state);
            // errorStreak — номер ошибки подряд: окно уведомляет только о первой, протухший токен не должен напоминать каждые 10 минут
            updateStatus({ phase: lastError ? 'error' : 'idle', current: null, running: [], lastRunAt: new Date().toISOString(), lastError, errorStreak: state.errorStreak });
        } else if (lastError) {
            console.error(`\nОшибки:\n${ctx.errors.join('\n')}`);
        }
        releaseLock();
        // Заявка, пришедшая между последней проверкой очереди и снятием лока, иначе ждала бы следующего интервала
        if (!dryRun && listQueue().length) kickstartWorker();
    }
};

const requireRepo = (slug) => {
    const repo = loadConfig().repos.find((candidate) => candidate.slug === slug);
    if (!repo) throw new Error(`Репозиторий ${slug} не подключён`);
    return repo;
};

// У Cursor уровень рассуждений зашит в id модели (grok-4.7-high), отдельного параметра нет
const EFFORT_KEY = { claude: 'effort', codex: 'reasoningEffort' };

// Модель и усилие меняются из окна настроек; подпись в комментариях следует за моделью, а маркер авторства остаётся прежним
// Список моделей Cursor зависит от аккаунта; окно настроек читает его из файла, чтобы не ходить в сеть при каждой отрисовке
const printCursorModels = async () => {
    const models = await listCursorModels(loadConfig().agents.cursor);
    writeJson(join(DATA_DIR, 'cursor-models.json'), { at: new Date().toISOString(), models });
    for (const model of models) console.log(`${model.id} — ${model.title}`);
};

const setBranchPattern = () => {
    const pattern = args[0];
    if (!pattern) throw new Error('Использование: branches <regexp>, например "PROJ-\\d+"');
    try {
        new RegExp(pattern, 'i');
    } catch (error) {
        throw new Error(`Неверное регулярное выражение: ${error.message}`);
    }
    const config = loadConfig();
    config.branchPattern = pattern;
    saveConfig(config);
    console.log(`Фоном ревьюятся ветки по шаблону ${pattern}`);
};

const agentCommand = () => {
    const [action, id] = args;
    const config = loadConfig();
    const agent = config.agents[id];
    if (action === 'models' && id === 'cursor') return printCursorModels();
    if (action !== 'set' || !agent) throw new Error(`Использование: agent set <${Object.keys(config.agents).join('|')}> [--model <id>] [--effort <уровень>|default] [--label <название>] [--auto on|off]`);
    const model = option('--model');
    const effort = option('--effort');
    const label = option('--label');
    const auto = option('--auto');
    if (model) agent.model = model;
    if (effort && !EFFORT_KEY[id]) throw new Error(`У ${agent.shortName} уровень reasoning выбирается вместе с моделью`);
    if (effort === 'default') {
        if (id === 'codex') throw new Error('Для Codex уровень reasoning нужно указать явно');
        delete agent[EFFORT_KEY[id]];
    } else if (effort) {
        agent[EFFORT_KEY[id]] = effort;
    }
    if (label && agent.signature) agent.signature = agent.signature.replace(/\[[^\]]*\]/, `[${label}]`);
    if (auto === 'on') delete agent.auto;
    else if (auto === 'off') agent.auto = false;
    else if (auto) throw new Error('--auto принимает on или off');
    saveConfig(config);
    const effortValue = agent[EFFORT_KEY[id]] ?? 'по умолчанию';
    console.log(`${agent.shortName}: ${agent.model}, усилие ${effortValue}, фоновое ревью ${agent.auto === false ? 'выключено' : 'включено'}`);
};

// Срок жизни токена выбирается при выпуске и нигде не читается; окно считает истечение от даты сохранения в Keychain
const setTokenLifetime = () => {
    const [id, value] = args;
    const config = loadConfig();
    const target = id === 'bitbucket' ? config.bitbucket : config.agents[id]?.keychainService ? config.agents[id] : null;
    const days = value === 'never' ? 0 : Number(value);
    if (!target || !Number.isInteger(days) || days < 0 || days > 3650) {
        const ids = ['bitbucket', ...Object.keys(config.agents).filter((key) => config.agents[key].keychainService)];
        throw new Error(`Использование: token <${ids.join('|')}> <дней|never>`);
    }
    target.tokenLifetimeDays = days;
    saveConfig(config);
    console.log(days ? `Токен ${id} живёт ${days} дн. с даты сохранения в Keychain` : `Токен ${id} без срока`);
};

// Секреты для фоновых запусков: id → service и account из config.json. Значение спрашивается без эха и нигде не печатается
const secretTargets = (config) => ({
    bitbucket: { service: config.bitbucket.keychainService, account: config.bitbucket.email },
    ...Object.fromEntries(Object.entries(config.agents).filter(([, agent]) => agent.keychainService).map(([id, agent]) => [id, { service: agent.keychainService, account: id }])),
});

const askHidden = (question) =>
    new Promise((resolve, reject) => {
        if (!process.stdin.isTTY) return reject(new Error('Нужен терминал: значение вводится с клавиатуры без эха'));
        process.stdout.write(question);
        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();
        let value = '';
        const done = (result) => {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener('data', onData);
            process.stdout.write('\n');
            result instanceof Error ? reject(result) : resolve(result);
        };
        const onData = (chunk) => {
            for (const char of chunk.toString('utf8')) {
                if (char === '\r' || char === '\n') return done(value);
                if (char === '\u0003') return done(new Error('Отменено'));
                if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
                else value += char;
            }
        };
        stdin.on('data', onData);
    });

const secretCommand = async () => {
    const [action = 'status', id] = args;
    const targets = secretTargets(loadConfig());
    if (action === 'status') {
        for (const [name, { service, account }] of Object.entries(targets)) console.log(`${name}: ${readSecret(service, account) || (name !== 'bitbucket' && readSecret(service)) ? 'есть' : 'нет'} (${service})`);
        return;
    }
    if (action !== 'set' || !targets[id]) throw new Error(`Использование: secret status | secret set <${Object.keys(targets).join('|')}>`);
    const value = (await askHidden(`${id}: вставьте значение (не отображается) и нажмите Enter: `)).trim();
    if (!value) throw new Error('Пустое значение — ничего не сохранено');
    // Токены моделей читаются без аккаунта: на Mac пишем в уже заведённую запись, а не рядом с ней
    const where = writeSecret(targets[id].service, targets[id].account, value, { reuseAccount: id !== 'bitbucket' });
    console.log(`Сохранено: ${id} → ${{ keychain: 'Keychain', libsecret: 'libsecret', file: 'файл с правами 600' }[where]} (${targets[id].service})`);
};

const dataCommand = () => {
    const [action, file] = args;
    if (action === 'export') {
        const target = file ?? `pr-reviewer-export-${new Date().toISOString().slice(0, 10)}.tar.gz`;
        const { file: path, bytes, archiveBytes } = exportData(target);
        console.log(`Архив ${path}: данных ${(bytes / 1e6).toFixed(1)} МБ, архив ${(archiveBytes / 1e6).toFixed(1)} МБ. Секретов, клонов и рабочих папок в нём нет`);
        return;
    }
    if (action === 'import' && file) {
        if (readWorkerPid()) throw new Error('Сейчас идёт проход — импортируйте, когда он закончится, или остановите сервис');
        const { dataDir, config, foreign } = importData(file, { force: hasFlag('--force') });
        console.log(`Данные разложены в ${dataDir}${config ? `, конфиг — ${config}` : ''}. Служебные клоны создадутся при первом проходе`);
        if (foreign.length) {
            console.log('В config.json пути с другой машины — поправьте их:');
            for (const { path, value } of foreign) console.log(`  ${path}: ${value}`);
        }
        return;
    }
    throw new Error('Использование: data export [файл.tar.gz] | data import <файл.tar.gz> [--force]');
};

const setPollInterval = () => {
    const minutes = Number(args[0]);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('Интервал — целое число минут от 1 до 1440');
    const config = loadConfig();
    config.intervalMinutes = minutes;
    saveConfig(config);
    console.log(`Фоновая проверка раз в ${minutes} мин`);
};

const review = () => {
    const config = loadConfig();
    const request = { repo: option('--repo'), pr: Number(option('--pr')), agent: option('--agent') };
    requireRepo(request.repo);
    if (!request.pr) throw new Error('Нужен --pr <id>');
    if (!config.agents[request.agent]) throw new Error(`Нужен --agent: ${Object.keys(config.agents).join(' | ')}`);
    enqueueReview(request);
    if (!readWorkerPid()) kickstartWorker();
    console.log(`Ревью ${request.repo}#${request.pr} от ${config.agents[request.agent].shortName} поставлено в очередь`);
};

// Обновляет только снимок PR для окна обзора: без лока и без изменения состояния воркера
const sync = async () => {
    const config = loadConfig();
    const bitbucket = createBitbucket(config.bitbucket);
    const failures = [];
    await Promise.all(
        config.repos.map(async (repo) => {
            try {
                // Без fetch: окно обновляет список часто, а свежие ветки клон получает на фоновом проходе
                await refreshSnapshot(bitbucket, repo, await bitbucket.listOpenPrs(repo), isCloned(repo.slug) ? cloneDir(repo.slug) : null);
            } catch (error) {
                failures.push(`${repo.slug}: ${error.message}`);
            }
        }),
    );
    if (failures.length) throw new Error(failures.join('\n'));
};

const ignoreCommand = () => {
    const [action = 'list', pattern] = args;
    const config = loadConfig();
    const patterns = config.ignorePaths ?? [];
    if (action === 'list') {
        if (hasFlag('--json')) return console.log(JSON.stringify(patterns));
        return console.log(patterns.length ? patterns.join('\n') : 'Исключений нет');
    }
    if (!pattern) throw new Error(`pr-reviewer ignore ${action} <шаблон>`);
    if (action === 'add') {
        if (patterns.includes(pattern)) throw new Error(`${pattern} уже исключён`);
        config.ignorePaths = [...patterns, pattern];
    } else if (action === 'remove') {
        if (!patterns.includes(pattern)) throw new Error(`${pattern} нет в исключениях`);
        config.ignorePaths = patterns.filter((candidate) => candidate !== pattern);
    } else {
        throw new Error(`Неизвестное действие: ignore ${action}`);
    }
    saveConfig(config);
    console.log(action === 'add' ? `Исключено ${pattern}` : `Больше не исключается ${pattern}`);
};

// stop с --repo и --pr касается только этого PR: снимает заявку из очереди или прерывает его идущую задачу
const stopTarget = () => {
    if (!option('--repo')) return [null, null];
    const pr = Number(option('--pr'));
    if (!pr) throw new Error('Нужен --pr <id>');
    return [requireRepo(option('--repo')).slug, pr];
};

const fixCommand = () => {
    if (args[0] === 'stop') {
        const [slug, pr] = stopTarget();
        return console.log(stopFix(slug, pr) ? `Доработка${slug ? ` ${slug}#${pr}` : ''} прервана` : `Доработка${slug ? ` ${slug}#${pr}` : ''} сейчас не идёт и не ждёт в очереди`);
    }
    const repo = requireRepo(option('--repo'));
    const pr = Number(option('--pr'));
    if (!pr) throw new Error('Нужен --pr <id>');
    const rebase = hasFlag('--rebase');
    requestFix(repo.slug, pr, rebase ? 'rebase' : 'fix');
    console.log(`${rebase ? 'Rebase' : 'Доработка'} ${repo.slug}#${pr} поставлен${rebase ? '' : 'а'} в очередь`);
};

// Разовый разбор истории PR в память: обычный проход видит только открытые PR и новые комментарии
const learnHistory = async (slug) => {
    const config = loadConfig();
    const repo = requireRepo(slug);
    const limit = Number(option('--prs') ?? 100);
    const dryRun = hasFlag('--dry-run');
    if (!dryRun && !acquireLock()) throw new Error('Сейчас идёт ревью — запустите, когда оно закончится');
    try {
        const bitbucket = createBitbucket(config.bitbucket);
        const state = loadState();
        const repoState = (state.repos[slug] ??= { prs: {} });
        const seen = new Set(repoState.learned ?? []);
        const prs = (await bitbucket.listRecentPrs(repo, limit)).filter((pr) => pr.comment_count > 0);
        let exchanges = [];
        for (const pr of prs) exchanges.push(...collectFeedback(pr, await bitbucket.listComments(repo, pr.id), config.agents, seen));
        const reviews = exchanges.filter((exchange) => exchange.kind === 'review').length;
        console.log(`${slug}: PR с комментариями ${prs.length}, новых обсуждений ${exchanges.length} (замечаний людей в ревью ${reviews}, ответов моделям ${exchanges.length - reviews})`);
        if (dryRun || !exchanges.length) return;
        const ctx = { config, dryRun: false, workDir: join(DATA_DIR, 'tmp') };
        mkdirSync(ctx.workDir, { recursive: true });
        const before = loadMemory(slug).length;
        while (exchanges.length) {
            const processed = await learn(ctx, repo, exchanges);
            if (!processed.length) throw new Error('Модель не разобрала обсуждения — подробности в журнале');
            for (const exchange of processed) exchange.newIds.forEach((id) => seen.add(id));
            repoState.learned = [...seen].slice(-5000);
            saveState(state);
            exchanges = exchanges.filter((exchange) => !processed.includes(exchange));
            console.log(`  разобрано ${processed.length}, осталось ${exchanges.length}`);
        }
        console.log(`Правил в памяти: было ${before}, стало ${loadMemory(slug).length}`);
    } finally {
        if (!dryRun) releaseLock();
    }
};

// Разбор — только план: модель предлагает, человек смотрит и применяет отдельной командой
const memoryReview = async (slug) => {
    if (hasFlag('--discard')) {
        discardMemoryPlan(slug);
        return console.log('План разбора удалён');
    }
    const json = hasFlag('--json');
    // Окну нужен и признак «память изменилась после разбора»: отпечаток памяти считает только сервис
    const print = (plan) => console.log(json ? JSON.stringify({ ...plan, outdated: isPlanOutdated(slug, plan) }, null, 2) : renderMemoryPlan(slug, plan));
    if (hasFlag('--show')) {
        const existing = loadMemoryPlan(slug);
        if (existing) return print(existing);
        return console.log(json ? 'null' : `Сохранённого плана нет — запустите pr-reviewer memory review ${slug}`);
    }
    const config = loadConfig();
    if (!json) console.log(`Разбираю память ${slug}…`);
    print(await reviewMemory({ config, repo: requireRepo(slug), workDir: join(DATA_DIR, 'tmp') }));
};

// Исследование подбора правил (B-24): словарь тегов репозитория и отчёт по теневому журналу
const tagsCommand = async () => {
    const [, action, slug, ...rest] = args;
    if (!slug) throw new Error('pr-reviewer memory tags init|show|add|retag <slug> …');
    const repo = requireRepo(slug);
    const config = loadConfig();
    const workDir = join(DATA_DIR, 'tmp', 'rule-selection');
    if (action === 'show') {
        const data = loadSelection(slug);
        if (!data) return console.log(`Словаря тегов ${slug} нет`);
        if (hasFlag('--json')) return console.log(JSON.stringify(data, null, 2));
        const lessons = loadMemory(slug);
        console.log(`Словарь ${slug} (${data.vocabulary.length}), сообщества графа: ${data.graph.join(', ')}\n`);
        for (const { tag, description } of data.vocabulary) console.log(`«${tag}» — ${description} · правил ${lessons.filter((lesson) => data.lessonTags[lesson.id]?.includes(tag)).length}`);
        const general = lessons.filter((lesson) => data.lessonTags[lesson.id]?.[0] === GENERAL).length;
        const untagged = lessons.filter((lesson) => !data.lessonTags[lesson.id]).length;
        return console.log(`\n«${GENERAL}»: ${general} · без тегов: ${untagged} · всего правил: ${lessons.length}`);
    }
    if (action === 'add') {
        const [tag, ...words] = rest;
        addTag(slug, tag ?? '', words.join(' '));
        return console.log(`Тег «${tag}» добавлен. Разметить правила заново: pr-reviewer memory tags retag ${slug}`);
    }
    if (action !== 'init' && action !== 'retag') throw new Error(`Неизвестное действие: memory tags ${action}`);
    if (!acquireLock()) throw new Error('Сейчас идёт ревью — запустите, когда оно закончится');
    try {
        const graph = hasFlag('--graph-nolibs') ? ['native', 'nolibs'] : ['native'];
        const data = action === 'init' ? await initSelection({ config, repo, workDir, graph, force: hasFlag('--force') }) : await retagLessons({ config, repo, workDir });
        const lessons = loadMemory(slug);
        console.log(`Словарь ${slug}: ${data.vocabulary.map(({ tag }) => tag).join(', ')}. Размечено правил: ${lessons.filter((lesson) => data.lessonTags[lesson.id]).length} из ${lessons.length}`);
    } finally {
        releaseLock();
    }
};

const selectionCommand = () => {
    const [, action = 'report', slug] = args;
    if (action !== 'report') throw new Error('pr-reviewer memory selection report [<slug>] [--since <дата>] [--json]');
    if (slug && !slug.startsWith('--')) requireRepo(slug);
    const report = selectionReport({ repo: slug && !slug.startsWith('--') ? slug : null, since: option('--since') });
    console.log(hasFlag('--json') ? JSON.stringify(report, null, 2) : renderSelectionReport(report));
};

const memoryCommand = () => {
    const [action, slug, ...rest] = args;
    if (action === 'tags') return tagsCommand();
    if (action === 'selection') return selectionCommand();
    if (!slug) throw new Error('pr-reviewer memory list|add|remove <slug> …');
    requireRepo(slug);
    if (action === 'list') {
        const lessons = loadMemory(slug);
        if (hasFlag('--json')) {
            const { usage, since, runs } = lessonUsage(slug);
            return console.log(JSON.stringify({ since, runs, lessons: lessons.map((lesson) => ({ ...lesson, usage: usage.get(lesson.id) ?? null })) }, null, 2));
        }
        if (!lessons.length) return console.log('Память пуста');
        const { usage, since } = lessonUsage(slug);
        if (since) console.log(`Срабатывания считаются с ${since.slice(0, 10)}\n`);
        for (const lesson of lessons) {
            const origin = lesson.manual ? 'вручную' : lesson.source?.pr ? `PR #${lesson.source.pr}` : 'автоматически';
            console.log(`${lesson.id} · ${origin} · ${since ? `${usageLine(usage.get(lesson.id))} · ` : ''}${lesson.text}`);
        }
    } else if (action === 'add') {
        const text = rest.join(' ').trim();
        if (!text) throw new Error('Нужен текст правила');
        console.log(`Добавлено ${addLesson(slug, text).id}`);
    } else if (action === 'edit') {
        const [id, ...words] = rest;
        if (!id) throw new Error('Нужен id правила');
        updateLesson(slug, id, words.join(' '));
        console.log(`Изменено ${id}`);
    } else if (action === 'learn') {
        return learnHistory(slug);
    } else if (action === 'review') {
        return memoryReview(slug);
    } else if (action === 'history') {
        return console.log(hasFlag('--json') ? JSON.stringify(loadMemoryHistory(slug), null, 2) : renderMemoryHistory(slug, Number(option('--limit') ?? 30)));
    } else if (action === 'restore') {
        if (!acquireLock()) throw new Error('Сейчас идёт ревью и память может меняться — откатите, когда оно закончится');
        try {
            const { before, after } = restoreMemory(slug);
            console.log(`Разбор откачен: правил было ${before}, стало ${after}`);
        } finally {
            releaseLock();
        }
    } else if (action === 'apply') {
        if (!acquireLock()) throw new Error('Сейчас идёт ревью и память может меняться — примените, когда оно закончится');
        try {
            const { before, after } = applyMemoryPlan(slug);
            console.log(`План применён: правил было ${before}, стало ${after}`);
        } finally {
            releaseLock();
        }
    } else if (action === 'remove') {
        if (!rest[0]) throw new Error('Нужен id правила');
        removeLesson(slug, rest[0]);
        console.log(`Удалено ${rest[0]}`);
    } else {
        throw new Error(`Неизвестное действие: memory ${action}`);
    }
};

const ARCH_STATES = { queued: 'в очереди', running: 'идёт', done: 'готов', failed: 'ошибка' };

const archCommand = () => {
    const action = args[0] && !args[0].startsWith('--') ? args[0] : 'request';
    if (action === 'stop') {
        const [slug, pr] = stopTarget();
        return console.log(stopArch(slug, pr) ? `Архитектурное ревью${slug ? ` ${slug}#${pr}` : ''} прервано` : `Архитектурное ревью${slug ? ` ${slug}#${pr}` : ''} сейчас не идёт и не ждёт в очереди`);
    }
    if (action === 'list') {
        const states = listArchStates();
        if (hasFlag('--json')) return console.log(JSON.stringify(states, null, 2));
        if (!states.length) return console.log('Архитектурных ревью ещё не было');
        for (const state of states) {
            const verdict = state.result ? ` · ${state.result.report.verdict}` : '';
            console.log(`${state.repo}#${state.pr} · ${ARCH_STATES[state.state] ?? state.state}${verdict} · ${state.result?.title ?? ''}`);
        }
        return;
    }
    const repo = requireRepo(option('--repo'));
    const pr = Number(option('--pr'));
    if (!pr) throw new Error('Нужен --pr <id>');
    if (action === 'show') {
        const state = loadArchState(repo.slug, pr);
        if (!state) throw new Error(`Для ${repo.slug}#${pr} архитектурного ревью ещё не было`);
        return console.log(hasFlag('--json') ? JSON.stringify(state, null, 2) : renderArchReport(state));
    }
    if (action !== 'request') throw new Error('pr-reviewer arch --repo <slug> --pr <id> | arch show --repo <slug> --pr <id> [--json] | arch list [--json] | arch stop [--repo <slug> --pr <id>]');
    requestArch(repo.slug, pr);
    console.log(`Архитектурное ревью ${repo.slug}#${pr} поставлено в очередь; отчёт — pr-reviewer arch show --repo ${repo.slug} --pr ${pr}`);
};

const QA_USAGE = 'pr-reviewer qa plan --repo <slug> --pr <id> [--note <текст>] | qa run --repo <slug> --pr <id> [--only C1,C3] [--skip C2] [--add <кейс>]… [--note <текст>] | qa show --repo <slug> --pr <id> [--plan] [--json] | qa save --repo <slug> --pr <id> | qa list [--json] | qa stop [--repo <slug> --pr <id>]';

const optionList = (name) => args.flatMap((arg, index) => (arg === name && args[index + 1] !== undefined ? [args[index + 1]] : []));
const idList = (name) => (option(name) ?? '').split(',').map((id) => id.trim().toUpperCase()).filter(Boolean);

const qaCommand = () => {
    const [action] = args;
    if (action === 'stop') {
        const [slug, pr] = stopTarget();
        return console.log(stopQa(slug, pr) ? `Тестирование${slug ? ` ${slug}#${pr}` : ''} прервано` : `Тестирование${slug ? ` ${slug}#${pr}` : ''} сейчас не идёт и не ждёт в очереди`);
    }
    if (action === 'list') {
        const states = listQaStates();
        if (hasFlag('--json')) return console.log(JSON.stringify(states, null, 2));
        if (!states.length) return console.log('Тестирований ещё не было');
        for (const state of states) console.log(`${state.repo}#${state.pr} · ${QA_STATES[state.state] ?? state.state} · ${state.title ?? ''}`);
        return;
    }
    if (!['plan', 'run', 'show', 'save'].includes(action)) throw new Error(QA_USAGE);
    const repo = requireRepo(option('--repo'));
    const pr = Number(option('--pr'));
    if (!pr) throw new Error('Нужен --pr <id>');
    if (action === 'show') {
        const state = loadQaState(repo.slug, pr);
        if (!state) throw new Error(`Для ${repo.slug}#${pr} тестирования ещё не было`);
        if (hasFlag('--json')) return console.log(JSON.stringify(state, null, 2));
        // Упавший прогон без прошлого отчёта иначе молча показал бы план
        if (state.state === 'failed' && state.error) console.log(`Последний прогон не удался: ${state.error}\n`);
        return console.log(hasFlag('--plan') || !state.run ? renderQaPlan(state) : renderQaReport(state));
    }
    if (action === 'save') {
        const saved = saveQaTests(repo, pr);
        console.log(`Тесты сохранены в ${saved.checkout}${saved.branch ? ` (ветка ${saved.branch})` : ''}, без коммита:`);
        for (const file of saved.files) console.log(`  ${file.path}${file.path !== file.wanted ? ` — ${file.wanted} уже есть, сохранён рядом` : ''} · ${file.cases.join(', ')}`);
        if (saved.prBranch && saved.branch !== saved.prBranch) console.log(`Копия на ветке ${saved.branch ?? '(нет ветки)'}, а PR — ${saved.prBranch}: тесты написаны под код PR и до переключения на его ветку могут не пройти.`);
        return;
    }
    const frontend = qaSettings(loadConfig()).frontend;
    if (repo.slug !== frontend) throw new Error(`Тестирование в браузере пока только для ${frontend}`);
    const note = option('--note') ?? '';
    if (action === 'plan') {
        requestQaPlan(repo.slug, pr, note);
        return console.log(`План тестирования ${repo.slug}#${pr} поставлен в очередь; посмотреть — pr-reviewer qa show --repo ${repo.slug} --pr ${pr}`);
    }
    requestQaRun(repo.slug, pr, { only: idList('--only'), skip: idList('--skip'), extra: optionList('--add'), note });
    console.log(`Тестирование ${repo.slug}#${pr} поставлено в очередь; отчёт — pr-reviewer qa show --repo ${repo.slug} --pr ${pr}`);
};

const BACKLOG_ACTIONS = { filed: 'filed', drop: 'dropped', reopen: 'open' };

const backlogCommand = () => {
    const [action = 'list', id, ...rest] = args;
    const slug = option('--repo');
    if (action === 'learn' || action === 'triage') {
        if (hasFlag('--background')) return startInBackground(args);
        const config = loadConfig();
        const repos = slug ? [requireRepo(slug)] : config.repos;
        const options = { config, bitbucket: createBitbucket(config.bitbucket), repos, dryRun: hasFlag('--dry-run') };
        return action === 'learn' ? learnBacklog({ ...options, limit: Number(option('--prs') ?? 100) }) : triageBacklog(options);
    }
    if (action === 'stop') return console.log(stopJob() ? 'Задача бэклога прервана' : 'Задача бэклога сейчас не идёт');
    // Одной командой, а не по drop на запись: параллельные drop из окна перезаписывали бы backlog.json друг друга
    if (action === 'close-stale') {
        const stale = loadBacklog().filter((item) => item.status === 'open' && STALE.has(item.triage?.verdict) && (!slug || item.repo === slug));
        for (const item of stale) setBacklogStatus(item.id, 'dropped', `Неактуально (${VERDICTS[item.triage.verdict]}): ${item.triage.reason}`);
        return console.log(`Закрыто неактуальных: ${stale.length}`);
    }
    if (action === 'list' || action === 'export') {
        if (slug) requireRepo(slug);
        const statuses = hasFlag('--all') ? Object.keys(STATUSES) : ['open'];
        const items = loadBacklog().filter((item) => statuses.includes(item.status) && (!slug || item.repo === slug));
        if (hasFlag('--json')) return console.log(JSON.stringify(items, null, 2));
        if (action === 'export') return console.log(renderBacklog(items));
        if (!items.length) return console.log('Бэклог пуст');
        for (const item of items.sort((a, b) => a.repo.localeCompare(b.repo) || a.level.localeCompare(b.level))) {
            const prs = [...new Set(item.sources.map((source) => `#${source.pr}`))].join(', ');
            console.log(`${item.id} · ${item.repo} · [${item.level}] ${item.title} · ${itemPlace(item)} · PR ${prs} · ${STATUSES[item.status]}`);
        }
        return;
    }
    if (!BACKLOG_ACTIONS[action] || !id) {
        throw new Error('pr-reviewer backlog list|export [--repo <slug>] [--all] [--json] | filed <id> [задача] | drop <id> [причина] | reopen <id> | learn|triage [--repo <slug>] [--dry-run] | close-stale [--repo <slug>] | stop');
    }
    const item = setBacklogStatus(id, BACKLOG_ACTIONS[action], rest.join(' ').trim());
    console.log(`${item.id} · ${item.title}: ${STATUSES[item.status]}${item.ticket ? ` (${item.ticket})` : ''}`);
};

const repoCommand = async () => {
    const [action, target] = args;
    if (action === 'list' || !action) {
        const repos = listRepos();
        if (hasFlag('--json')) console.log(JSON.stringify(repos, null, 2));
        else for (const repo of repos) console.log(`${repo.workspace}/${repo.slug} · ${repo.cloned ? 'скачан' : 'не скачан'}${repo.paused ? ' · на паузе' : ''} · ${repo.remote}`);
        return;
    }
    if (!target) throw new Error(`pr-reviewer repo ${action} <…>`);
    if (action === 'add') {
        const bitbucket = createBitbucket(loadConfig().bitbucket);
        const repo = await addRepo(bitbucket, target, { source: option('--source') });
        // Окно настроек скачивает отдельной командой `repo clone`, чтобы закрыть диалог сразу после проверки доступа
        if (hasFlag('--json')) return console.log(JSON.stringify(repo));
        console.log(`Подключён ${repo.workspace}/${repo.slug}${repo.source ? `, клон с ${repo.source}` : ''}. Скачиваю…`);
        console.log(`Скачан в ${await cloneRepo(bitbucket, repo.slug)}`);
    } else if (action === 'clone') {
        requireRepo(target);
        console.log(`Скачан в ${await cloneRepo(createBitbucket(loadConfig().bitbucket), target)}`);
    } else if (action === 'pause' || action === 'resume') {
        setRepoPaused(target, action === 'pause');
        console.log(action === 'pause' ? `Фоновое ревью ${target} на паузе, явные запуски работают` : `Ревью ${target} возобновлено`);
    } else if (action === 'remove') {
        if (readWorkerPid() && (loadStatus().running ?? []).some((entry) => entry.repo === target)) throw new Error(`Сейчас идёт ревью в ${target}, сначала прервите его`);
        removeRepo(target);
        console.log(`${target} отключён, служебный клон удалён`);
    } else {
        throw new Error(`Неизвестное действие: repo ${action}`);
    }
};

const stop = () => {
    clearQueue();
    const pid = readWorkerPid();
    // launchd запускает воркер лидером своей группы: сигнал группе убивает и синхронный git, который держит проход
    if (pid) requestStop(pid, STOP_FILE);
    console.log(pid ? `Остановлен запуск ${pid}` : 'Ревью сейчас не идёт');
};

const printStatus = () => {
    const status = loadStatus();
    const pid = readWorkerPid();
    console.log(`Состояние: ${isPaused() ? 'пауза' : pid ? 'идёт ревью' : status.phase}`);
    for (const current of pid ? (status.running ?? []) : []) console.log(`Сейчас: ${current.repo}#${current.pr} · ${current.agent} (${current.role})`);
    if (status.lastRunAt) console.log(`Последний запуск: ${new Date(status.lastRunAt).toLocaleString('ru-RU')}`);
    if (status.lastError) console.log(`Последняя ошибка: ${status.lastError}`);
    for (const entry of (status.recent ?? []).slice(0, 10)) {
        const findings = Object.entries(entry.findings).filter(([, n]) => n).map(([l, n]) => `${l}×${n}`).join(' ') || 'без замечаний';
        console.log(`  ${entry.repo}#${entry.pr} · ${entry.agent} (${entry.role}) · ${findings} · ${entry.url}`);
    }
};

const commands = {
    run,
    stop,
    pause: () => {
        setPaused(true);
        stop();
    },
    resume: () => {
        setPaused(false);
        console.log('Ревью возобновлено');
    },
    'run-now': () => {
        requestRun();
        kickstartWorker();
        console.log('Запуск поставлен');
    },
    review,
    sync,
    interval: setPollInterval,
    agent: agentCommand,
    branches: setBranchPattern,
    token: setTokenLifetime,
    secret: secretCommand,
    data: dataCommand,
    limits: async () => {
        const limits = await refreshLimits(loadConfig());
        for (const [agent, value] of Object.entries(limits)) {
            if (agent === 'errors' || !value) continue;
            console.log(`${agent}: использовано ${value.usedPercent}% (${value.window === 'month' ? 'месяц' : 'неделя'}), сброс ${value.resetsAt ?? '—'}`);
        }
        for (const [agent, error] of Object.entries(limits.errors)) console.log(`${agent}: не удалось получить — ${error}`);
    },
    memory: memoryCommand,
    backlog: backlogCommand,
    arch: archCommand,
    qa: qaCommand,
    'qa-worker': () => qaWorker({ loadConfig, createBitbucket }),
    'arch-worker': () => archWorker({ loadConfig, createBitbucket }),
    fix: fixCommand,
    'fix-worker': () => fixWorker({ loadConfig, createBitbucket }),
    ignore: ignoreCommand,
    repo: repoCommand,
    status: printStatus,
    stats: () => console.log(formatStats(loadStats(), loadOutcomes(), loadState(), loadConfig().agents)),
    help: () =>
        console.log(`pr-reviewer <команда>

  run [--dry-run] [--repo <slug>] [--pr <id>] [--force]
                 один проход по открытым PR; --dry-run печатает комментарии вместо публикации
                 и не трогает состояние; --force запускает и на паузе
  run-now        запустить проход сейчас (launchd на macOS, systemd на Linux)
  review --repo <slug> --pr <id> --agent <id>
                 поставить явное ревью одной моделью в очередь (работает и на паузе)
  sync           обновить список открытых PR для окна обзора
  fix --repo <slug> --pr <id> [--rebase] | fix stop [--repo <slug> --pr <id>]
                 доработка PR по открытым замечаниям: rebase на базу, зависимости, правки Claude и коммит, проверки, push --force-with-lease;
                 --rebase — то же без правок
  ignore list | add <шаблон> | remove <шаблон>
                 файлы, которые вырезаются из диффа перед ревью (glob, например **/yarn.lock)
  memory list <slug> [--json] | add <slug> <текст> | edit <slug> <id> <текст> | remove <slug> <id>
                 list --json — правила со срабатываниями: { since, runs, lessons: [{ …, usage }] }
  memory review <slug> [--show] [--json] [--discard] | memory apply <slug>
                 разбор памяти: модель предлагает склеить дубли, удалить бесполезное и устаревшее, переписать размытое;
                 --show — показать сохранённый план без нового разбора, apply — применить его (вручную добавленные правила не трогаются)
  memory history <slug> [--limit <N>] [--json] | memory restore <slug>
                 журнал изменений памяти: выучено, правки, удаления, разборы; restore откатывает последний разбор
  memory learn <slug> [--prs <N>] [--dry-run]
  memory tags init <slug> [--graph-nolibs] [--force] | tags show <slug> [--json] | tags add <slug> <тег> <описание> | tags retag <slug>
  memory selection report [<slug>] [--since <дата>] [--json]
                 разобрать в память комментарии людей из последних N PR (по умолчанию 100) любого состояния
                 память ревьюеров: правила из ответов команды, которые учитываются в ревью
  arch --repo <slug> --pr <id>
                 архитектурное ревью: цель PR, альтернативы с плюсами и минусами, где проще, серьёзные риски;
                 отчёт только локальный, в PR не публикуется
  arch show --repo <slug> --pr <id> [--json] | arch list [--json] | arch stop [--repo <slug> --pr <id>]
  qa plan --repo <slug> --pr <id> [--note <текст>]
                 тестирование PR, этап 1: план — опасные места и кейсы (юнит, компонентные, e2e); --note — свои кейсы и на что смотреть
  qa run --repo <slug> --pr <id> [--only C1,C3] [--skip C2] [--add <кейс>]… [--note <текст>]
                 этап 2: тесты на Vitest; для e2e — локальный бэкенд в Docker, фронтенд из ветки PR, Playwright с видео и скриншотами
  qa show --repo <slug> --pr <id> [--plan] [--json] | qa list [--json] | qa stop [--repo <slug> --pr <id>]
  qa save --repo <slug> --pr <id>
                 тесты последнего прогона — в локальную копию репозитория (source), без коммита
  backlog list|export [--repo <slug>] [--all] [--json]
                 проблемы вне скоупа PR, которые модели нашли по ходу ревью; export — markdown для разбора
  backlog filed <id> [задача] | drop <id> [причина] | reopen <id>
                 итог разбора: задача заведена, отклонено или вернуть в ожидание
  backlog learn [--repo <slug>] [--prs <N>] [--dry-run] [--background]
                 собрать в бэклог отложенные проблемы из незакрытых тредов влитых PR среди последних N (по умолчанию 100);
                 разобранные треды запоминаются, повторный запуск смотрит только новые обсуждения
  backlog triage [--repo <slug>] [--dry-run] [--background] | backlog stop
                 проверить по коду основной ветки, актуальны ли ждущие разбора записи; закрывает человек
  backlog close-stale [--repo <slug>]
                 отклонить записи, которые разбор по коду счёл неактуальными (решено, удалено, не баг)
  interval <мин> как часто проверять PR в фоне; действует со следующей минуты, без переустановки
  branches <regexp>
                 какие исходные ветки PR ревьюятся фоном (остальные — только вручную)
  secret status | secret set <bitbucket|claude|cursor>
                 есть ли токены в хранилище; set спрашивает значение без эха и сохраняет (Keychain, libsecret или файл 600)
  data export [файл.tar.gz] | data import <файл.tar.gz> [--force]
                 перенос данных на другую машину: память, статистика, исходы, бэклог, состояние, config.json — без секретов и клонов
  token <bitbucket|claude|cursor> <дней|never>
                 срок жизни токена, выбранный при выпуске; окно предупреждает за 14 дней до истечения
  limits         обновить остатки лимитов подписок (Claude обновляет их сам при каждом запуске)
  agent set <claude|codex|cursor> [--model <id>] [--effort <уровень>|default] [--label <название>] [--auto on|off]
                 модель и уровень reasoning (у Cursor уровень входит в id модели, --effort нет); --auto off убирает модель
                 из фонового ревью, ручной запуск остаётся
  repo list [--json] | add <ссылка> [--source <путь>] [--json] | clone <slug> | pause|resume <slug> | remove <slug>
                 подключённые репозитории; add проверяет доступ и скачивает клон (с --json только подключает)
  stop           прервать текущий проход и очистить очередь заявок
  pause|resume   поставить на паузу (с прерыванием) или продолжить
  status         состояние и последние ревью
  stats          сравнение моделей`),
};

try {
    await (commands[command] ?? commands.help)();
} catch (error) {
    // Команды из окна (sync, review, repo) запускаются без терминала — без лога их ошибки пропали бы
    logError(`${[command, ...args].join(' ')}: ${error.message}`);
    console.error(error.message);
    process.exit(1);
}
