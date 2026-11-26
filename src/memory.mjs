import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runStructured } from './agents.mjs';
import { authorOf, buildThreads } from './comments.mjs';
import { EVICTION_WINDOW, countLessonUsage, pickEvictions, plural } from './lesson-usage.mjs';
import { DATA_DIR, TOOL_DIR, appendSpend, loadConfig, log, logError } from './store.mjs';

const MEMORY_DIR = join(DATA_DIR, 'memory');
const LESSONS_SCHEMA = join(TOOL_DIR, 'schema/lessons.schema.json');
// Память целиком идёт в промпт каждого ревью, поэтому её размер ограничен; вытесняются наименее полезные автоматические правила.
// Окно предупреждает заранее, чтобы до вытеснения дошло только то, что человек не успел просмотреть
const maxLessons = () => loadConfig().memory?.maxLessons ?? 60;
const MAX_EXCHANGES = 30;

const memoryFile = (slug) => join(MEMORY_DIR, `${slug}.json`);
const historyFile = (slug) => join(MEMORY_DIR, `${slug}.history.jsonl`);

// Журнал изменений памяти: что добавлено, удалено и переписано, кем и почему. Ручная правка файла в редакторе сюда не попадает
// kind: learn — выучено из PR, add/edit/remove — вручную, evict — вытеснено при переполнении, review — разбор, restore — откат
export const appendMemoryHistory = (slug, entry) => {
    mkdirSync(MEMORY_DIR, { recursive: true });
    const record = { at: new Date().toISOString(), added: [], removed: [], changed: [], ...entry };
    appendFileSync(historyFile(slug), `${JSON.stringify(record)}\n`);
};

export const loadMemoryHistory = (slug) => {
    try {
        return readFileSync(historyFile(slug), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
        return [];
    }
};

const brief = (lesson) => ({ id: lesson.id, text: lesson.text });

// Файл можно править руками (в VS Code из окна памяти), поэтому битый JSON — не «пустая память»:
// ревью идёт без правил, а запись в файл запрещена, иначе следующее выученное правило затёрло бы всё остальное
// broken — текст причины, если файл памяти не читается: его показывает приложение баннером «Память повреждена»
export const readMemory = (slug) => {
    const path = memoryFile(slug);
    if (!existsSync(path)) return { lessons: [] };
    try {
        const lessons = JSON.parse(readFileSync(path, 'utf8')).lessons;
        if (!Array.isArray(lessons)) throw new Error('нет массива lessons');
        // Те же обязательные поля проверяет окно — иначе оно и сервис по-разному считали бы файл исправным
        const index = lessons.findIndex((lesson) => !['id', 'text', 'at'].every((field) => typeof lesson?.[field] === 'string'));
        if (index >= 0) throw new Error(`у правила ${index + 1} нет id, text или at`);
        return { lessons };
    } catch (error) {
        return { lessons: [], broken: `память ${slug} повреждена (${error.message}) — исправьте ${path}` };
    }
};

export const loadMemory = (slug) => {
    const { lessons, broken } = readMemory(slug);
    if (broken) logError(`${broken}; ревью идёт без правил памяти`);
    return lessons;
};

export const saveMemory = (slug, lessons) => {
    const { broken } = readMemory(slug);
    if (broken) throw new Error(`${broken}; изменения памяти не сохранены`);
    mkdirSync(MEMORY_DIR, { recursive: true });
    const path = memoryFile(slug);
    writeFileSync(`${path}.tmp`, `${JSON.stringify({ lessons }, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
};

export const newId = () => `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const trim = (slug, lessons) => {
    const limit = maxLessons();
    const { victims, short } = pickEvictions(lessons, lessons.length - limit, countLessonUsage(slug, lessons));
    for (const { lesson, reason } of victims) log(`${slug}: память заполнена, вытеснено правило (${reason}) — ${lesson.text}`);
    if (short) log(`${slug}: предупреждение — память переполнена (${lessons.length - victims.length} из ${limit}), а вытеснять нечего: остальные правила ручные, исправленные или младше ${EVICTION_WINDOW} запусков. Удалите лишние правила или поднимите memory.maxLessons`);
    if (victims.length) appendMemoryHistory(slug, { kind: 'evict', reason: `память заполнена (${plural(limit, ['правило', 'правила', 'правил'])})`, removed: victims.map(({ lesson, reason }) => ({ ...brief(lesson), reason })) });
    const ids = new Set(victims.map(({ lesson }) => lesson.id));
    return lessons.filter((lesson) => !ids.has(lesson.id));
};

export const addLesson = (slug, text, source = null) => {
    const lesson = { id: newId(), text: text.trim(), at: new Date().toISOString(), ...(source ? { source } : { manual: true }) };
    const next = trim(slug, [...loadMemory(slug), lesson]);
    saveMemory(slug, next);
    appendMemoryHistory(slug, { kind: source ? 'learn' : 'add', ...(source?.url ? { pr: source.pr, url: source.url } : {}), added: [brief(lesson)] });
    return lesson;
};

export const updateLesson = (slug, id, text) => {
    const lessons = loadMemory(slug);
    const lesson = lessons.find((candidate) => candidate.id === id);
    if (!lesson) throw new Error(`В памяти ${slug} нет правила ${id}`);
    if (!text.trim()) throw new Error('Текст правила пустой');
    const before = lesson.text;
    lesson.text = text.trim();
    lesson.edited = true;
    saveMemory(slug, lessons);
    appendMemoryHistory(slug, { kind: 'edit', changed: [{ id, before, after: lesson.text }] });
};

export const removeLesson = (slug, id) => {
    const lessons = loadMemory(slug);
    const lesson = lessons.find((candidate) => candidate.id === id);
    if (!lesson) throw new Error(`В памяти ${slug} нет правила ${id}`);
    saveMemory(slug, lessons.filter((candidate) => candidate.id !== id));
    appendMemoryHistory(slug, { kind: 'remove', removed: [brief(lesson)] });
};

export const renderThread = (thread, agents) => {
    const root = thread[0];
    const line = root.inline?.to ?? root.inline?.from;
    const where = root.inline?.path ? `файл \`${root.inline.path}\`${line ? `, строка ${line}` : ''}` : 'общий комментарий к PR';
    const body = thread
        .map((comment) => {
            const who = authorOf(comment, agents);
            const label = who === 'human' ? `человек (${comment.user?.display_name ?? 'неизвестно'})` : agents[who].shortName;
            return `[${comment.id}] ${label}:\n${comment.content?.raw ?? ''}`;
        })
        .join('\n\n');
    return `${where}\n\n${body}`;
};

// kind: reply — люди ответили на замечание модели (чаще всего «так не надо»);
// review — человек сам открыл тред в ревью (что команда проверяет), к нему критерии отбора строже
export const collectFeedback = (pr, comments, agents, seen) => {
    const human = (comment) => authorOf(comment, agents) === 'human';
    const exchanges = [];
    for (const { root, replies } of buildThreads(comments)) {
        const thread = [root, ...replies].filter((comment) => !comment.deleted && !comment.pending).sort((a, b) => a.id - b.id);
        if (thread[0]?.id !== root.id) continue;
        const fresh = thread.filter((comment) => human(comment) && !seen.has(comment.id));
        if (!fresh.length) continue;
        exchanges.push({
            kind: human(root) ? 'review' : 'reply',
            pr: pr.id,
            url: pr.links.html.href,
            rootId: root.id,
            newIds: fresh.map((comment) => comment.id),
            authors: [...new Set(fresh.map((comment) => comment.user?.display_name).filter(Boolean))],
            text: renderThread(thread, agents),
        });
    }
    return exchanges;
};

const section = (title, exchanges) =>
    exchanges.length
        ? `## ${title}\n\n${exchanges.map((exchange) => `### PR #${exchange.pr}, тред ${exchange.rootId}\n\n${exchange.text}`).join('\n\n---\n\n')}`
        : null;

const listNames = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} и ${names.at(-1)}` : names[0]);

// Список моделей — из конфига: модель памяти должна узнавать замечания каждой из них
const reviewersLine = (agents) => {
    const names = Object.values(agents).map((agent) => agent.shortName);
    return names.length > 1 ? `Модели ${listNames(names)} оставляют замечания` : `Модель ${names[0]} оставляет замечания`;
};

const buildPrompt = (repo, agents, lessons, exchanges) =>
    [
        `Ты ведёшь память ревьюеров кода репозитория \`${repo.workspace}/${repo.slug}\`. ${reviewersLine(agents)} в pull request, люди из команды отвечают им и сами ревьюят код. По этой памяти модели будут ревьюить следующие PR так, как это делает команда.`,
        'Выдели устойчивые знания, которые должны изменить будущие ревью в этом репозитории. Источников два, и критерии у них разные.',
        '**Ответы людей на замечания моделей** чаще всего говорят, чего не нужно: что задумано так и не является ошибкой, какие классы замечаний команда считает ложными или неважными, особенности предметной области и окружения.',
        '**Замечания, которые люди сами оставили в ревью,** показывают, что команда проверяет. Здесь будь строже: бери только обобщаемые правила — устройство API, обработка ошибок и транзакций, где что вычисляется и проверяется, безопасность, работа с данными, архитектурные границы. Правило должно быть применимо к другим PR: с обоснованием в треде или повторяющееся в нескольких тредах. Разовые предложения по именам переменных и методов, формулировкам, порядку кода и прочая вкусовщина в память не идут, даже если звучат как совет: моделям запрещено писать стилистические замечания.',
        'Не записывай решение отложить проблему — прямое («в бэклог», «отдельной задачей») или косвенное («сделаем позже», «пока не до этого», «в других местах так же, поправим разом»). Команда признаёт замечание верным, просто не сейчас: оно уходит в бэклог, а правило «не требовать» заглушило бы его в следующих PR. Если в таком ответе есть знание, не связанное с откладыванием, бери только его.',
        'Не записывай: подтверждения исправления («поправил», «ок», «спасибо»), детали только этого PR, общие истины программирования, мнение одного человека без обоснования, если оно противоречит здравому смыслу. Если полезных знаний нет — верни пустой список, это нормальный и частый результат.',
        'Каждое правило — одно-два предложения по-русски, самодостаточное, понятное без треда, с конкретными сущностями в `обратных кавычках`. Формулируй как правило для ревьюера: что проверять или чего не требовать. В `commentIds` — id комментариев людей, из которых правило выведено.',
        lessons.length
            ? `Уже известные правила — не повторяй их и не переформулируй:\n\n${lessons.map((lesson) => `- ${lesson.text}`).join('\n')}`
            : 'Известных правил пока нет.',
        section('Ответы людей на замечания моделей', exchanges.filter((exchange) => exchange.kind !== 'review')),
        section('Замечания людей в ревью', exchanges.filter((exchange) => exchange.kind === 'review')),
        'Ничего не изменяй в файлах. Верни JSON по схеме.',
    ]
        .filter(Boolean)
        .join('\n\n');

// Возвращает обработанные обмены — их больше не показываем модели; при ошибке пусто, повторим на следующем проходе
export const learn = async (ctx, repo, exchanges) => {
    if (!exchanges.length || ctx.dryRun) return [];
    // Правила из битого файла всё равно не сохранить — не тратим запуск модели, обсуждения подождут исправления файла
    const { broken } = readMemory(repo.slug);
    if (broken) {
        logError(`${broken}; разбор обсуждений в память отложен (ждут: ${exchanges.length})`);
        return [];
    }
    const agentId = ctx.config.memory?.agent ?? 'claude';
    const agent = ctx.config.agents[agentId];
    const batch = exchanges.slice(0, MAX_EXCHANGES);
    const lessons = loadMemory(repo.slug);
    const startedAt = Date.now();
    try {
        const { data, usage } = await runStructured(agentId, agent, {
            cwd: ctx.workDir,
            workDir: ctx.workDir,
            prompt: buildPrompt(repo, ctx.config.agents, lessons, batch),
            schemaPath: LESSONS_SCHEMA,
        });
        appendSpend('memory-learn', repo.slug, agentId, agent, usage, startedAt);
        const byComment = new Map(batch.flatMap((exchange) => exchange.newIds.map((id) => [id, exchange])));
        for (const lesson of data.lessons ?? []) {
            const exchange = lesson.commentIds.map((id) => byComment.get(id)).find(Boolean) ?? batch[0];
            addLesson(repo.slug, lesson.text, { pr: exchange.pr, url: exchange.url, commentIds: lesson.commentIds, authors: exchange.authors, kind: exchange.kind ?? 'reply' });
            log(`${repo.slug}: в память добавлено правило — ${lesson.text}`);
        }
        const cost = usage.costUsd != null ? `, $${usage.costUsd.toFixed(2)}` : '';
        log(`${repo.slug}: память — разобрано обсуждений ${batch.length}, новых правил ${data.lessons?.length ?? 0}${cost}`);
        return batch;
    } catch (error) {
        logError(`${repo.slug}: не удалось обновить память — ${error.message}`);
        return [];
    }
};
