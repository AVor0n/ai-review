import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runStructured } from './agents.mjs';
import { resolveCommit } from './git.mjs';
import { loadMemory } from './memory.mjs';
import { defaultRef } from './memory-review.mjs';
import { loadGraph } from './rule-graph.mjs';
import { DATA_DIR, TOOL_DIR, appendJsonl, appendSpend, loadJsonl, loadOutcomes, loadStats, log, readJson, writeJson } from './store.mjs';

// Исследование B-24: какие правила памяти подставила бы каждая стратегия подбора. Теневой режим — ревью получает всю память,
// здесь только журнал. T — смысловые теги, G — сообщества графа кода, TG — объединение; G′ и TG′ — сообщества без библиотечных узлов
export const GENERAL = 'общее';
export const JOURNAL_FILE = join(DATA_DIR, 'rule-selection.jsonl');
const selectionFile = (slug) => join(DATA_DIR, 'memory', `${slug}.selection.json`);
const VOCABULARY_SCHEMA = join(TOOL_DIR, 'schema/rule-vocabulary.schema.json');
const RULE_TAGS_SCHEMA = join(TOOL_DIR, 'schema/rule-tags.schema.json');
const PR_TAGS_SCHEMA = join(TOOL_DIR, 'schema/pr-tags.schema.json');
const MAX_DIFF_CHARS = 40_000;
const MAX_TAGS = 3;
export const STRATEGIES = { T: 'T', G: 'G', TG: 'TG', G2: 'G′', TG2: 'TG′' };

export const loadSelection = (slug) => readJson(selectionFile(slug), null);
const saveSelection = (slug, data) => writeJson(selectionFile(slug), data);

// Строка правила в промпте ревью — по ней считается размер подбора
export const lessonChars = (lesson) => `- [${lesson.id}] ${lesson.text}\n`.length;

// Дешёвый запуск: модель памяти с низким effort, если в конфиге не задано иное
const taggingAgent = (config) => {
    const tagging = config.memory?.tagging ?? {};
    const agentId = tagging.agent ?? config.memory?.agent ?? 'claude';
    const effort = tagging.effort ?? 'low';
    return { agentId, agent: { ...config.agents[agentId], ...(tagging.model ? { model: tagging.model } : {}), effort, reasoningEffort: effort } };
};

const runTagging = async (config, workDir, kind, slug, prompt, schemaPath) => {
    const { agentId, agent } = taggingAgent(config);
    mkdirSync(workDir, { recursive: true });
    const startedAt = Date.now();
    const { data, usage } = await runStructured(agentId, agent, { cwd: workDir, workDir, prompt, schemaPath });
    appendSpend(kind, slug, agentId, agent, usage, startedAt);
    return data;
};

const renderVocabulary = (vocabulary) => vocabulary.map(({ tag, description }) => `- «${tag}» — ${description}`).join('\n');
const renderLessons = (lessons) => lessons.map((lesson) => `- [${lesson.id}] ${lesson.text}`).join('\n');

// Только теги словаря, не больше трёх; «общее» — единственный тег правила, которое нужно любому PR
const cleanTags = (tags, vocabulary, { allowGeneral }) => {
    const known = new Map(vocabulary.map(({ tag }) => [tag.trim().toLowerCase(), tag]));
    const normalized = [...new Set(tags.map((tag) => tag.trim().toLowerCase()))];
    if (allowGeneral && normalized.includes(GENERAL)) return [GENERAL];
    return normalized.map((tag) => known.get(tag)).filter(Boolean).slice(0, MAX_TAGS);
};

const LESSON_TAG_RULES = `Каждому правилу поставь от одного до трёх тегов словаря: в каких PR ревьюеру понадобится это правило. Если правило нужно в любом PR (общий стиль ревью, что вообще не замечать), поставь единственный тег «${GENERAL}». Не придумывай теги вне словаря.`;

const vocabularyPrompt = (repo, lessons) => `Ты готовишь подбор правил памяти ревьюеров кода репозитория \`${repo.workspace}/${repo.slug}\`. Сейчас все правила идут в промпт каждого ревью; позже перед ревью модель будет отмечать теги PR и подставлять только правила с этими тегами.

Составь закрытый словарь из 10–20 тегов для этого репозитория по правилам ниже. Тег описывает действие или область изменений, по которым видно, что правило понадобится: например «новая миграция», «MyBatis-запрос», «импорт CSV», «тестовый датасет», «контракт с фронтом», «права доступа». Тег — одно-три слова по-русски строчными буквами. Теги не должны пересекаться по смыслу: не «миграция» и «миграции БД» одновременно. \`description\` — одно предложение: по каким признакам PR этот тег ему ставится. Тег «${GENERAL}» в словарь не включай.

${LESSON_TAG_RULES}

Правила:

${renderLessons(lessons)}

Ничего не изменяй в файлах. Верни JSON по схеме.`;

const lessonTagsPrompt = (repo, vocabulary, lessons) => `Ты размечаешь правила памяти ревьюеров кода репозитория \`${repo.workspace}/${repo.slug}\` тегами закрытого словаря.

Словарь:

${renderVocabulary(vocabulary)}

${LESSON_TAG_RULES}

Правила:

${renderLessons(lessons)}

Ничего не изменяй в файлах. Верни JSON по схеме.`;

const prTagsPrompt = (repo, vocabulary, { pr, description, commits, files, diff }) => `Определи, какие теги закрытого словаря относятся к pull request в репозитории \`${repo.workspace}/${repo.slug}\`. По тегам будут подобраны правила для ревью этого PR, поэтому пропущенный тег хуже лишнего: ставь тег, если PR хоть как-то затрагивает его область или действие. Если не подходит ни один — верни пустой список.

Словарь:

${renderVocabulary(vocabulary)}

## PR #${pr.id}: ${pr.title}

${description || '(описания нет)'}

## Коммиты

${commits.join('\n') || '(нет)'}

## Изменённые файлы

${files.join('\n')}

## Дифф${diff.length > MAX_DIFF_CHARS ? ' (обрезан)' : ''}

\`\`\`diff
${diff.slice(0, MAX_DIFF_CHARS)}
\`\`\`

Ничего не изменяй в файлах. Верни JSON по схеме.`;

const applyLessonTags = (data, lessons, answer) => {
    const ids = new Set(lessons.map((lesson) => lesson.id));
    for (const { id, tags } of answer.lessons ?? []) {
        if (!ids.has(id)) continue;
        const clean = cleanTags(tags, data.vocabulary, { allowGeneral: true });
        if (clean.length) data.lessonTags[id] = clean;
    }
};

// Один раз на репозиторий: словарь по текущим правилам и сразу разметка всех правил.
// graph — какие сообщества мерить: native (родные Graphify) и/или nolibs (без библиотечных узлов)
export const initSelection = async ({ config, repo, workDir, graph = ['native'], force = false }) => {
    if (loadSelection(repo.slug) && !force) throw new Error(`Словарь тегов ${repo.slug} уже есть — пересоздать: --force`);
    const lessons = loadMemory(repo.slug);
    if (!lessons.length) throw new Error(`Память ${repo.slug} пуста — размечать нечего`);
    const answer = await runTagging(config, workDir, 'rule-vocabulary', repo.slug, vocabularyPrompt(repo, lessons), VOCABULARY_SCHEMA);
    const vocabulary = (answer.vocabulary ?? [])
        .map(({ tag, description }) => ({ tag: tag.trim().toLowerCase(), description: description.trim() }))
        .filter(({ tag }, index, all) => tag && tag !== GENERAL && all.findIndex((other) => other.tag === tag) === index);
    if (vocabulary.length < 5) throw new Error(`модель вернула слишком маленький словарь (${vocabulary.length} тегов)`);
    const previous = loadSelection(repo.slug);
    const data = { createdAt: new Date().toISOString(), graph, vocabulary, lessonTags: {}, lessonFiles: previous?.lessonFiles ?? {}, prFiles: previous?.prFiles ?? {} };
    applyLessonTags(data, lessons, answer);
    await tagMissingLessons(config, repo, workDir, data, lessons);
    saveSelection(repo.slug, data);
    return data;
};

// Новые, склеенные и добавленные вручную правила размечаются тем же словарём; словарь при этом не растёт
const tagMissingLessons = async (config, repo, workDir, data, lessons) => {
    const missing = lessons.filter((lesson) => !data.lessonTags[lesson.id]);
    if (!missing.length) return false;
    const answer = await runTagging(config, workDir, 'rule-tags', repo.slug, lessonTagsPrompt(repo, data.vocabulary, missing), RULE_TAGS_SCHEMA);
    applyLessonTags(data, missing, answer);
    // Модель могла пропустить правило: без тегов оно не попадёт в T, и это будет видно в отчёте как потеря
    return true;
};

export const retagLessons = async ({ config, repo, workDir }) => {
    const data = loadSelection(repo.slug);
    if (!data) throw new Error(`Словаря тегов ${repo.slug} нет — сначала pr-reviewer memory tags init ${repo.slug}`);
    data.lessonTags = {};
    await tagMissingLessons(config, repo, workDir, data, loadMemory(repo.slug));
    saveSelection(repo.slug, data);
    return data;
};

// Словарь расширяется только явно, иначе при разметке появились бы синонимы одного тега
export const addTag = (slug, tag, description) => {
    const data = loadSelection(slug);
    if (!data) throw new Error(`Словаря тегов ${slug} нет — сначала pr-reviewer memory tags init ${slug}`);
    const name = tag.trim().toLowerCase();
    if (!name || name === GENERAL) throw new Error('Недопустимое имя тега');
    if (data.vocabulary.some((item) => item.tag === name)) throw new Error(`Тег «${name}» уже есть`);
    if (!description?.trim()) throw new Error('Нужно описание тега: по каким признакам PR он ставится');
    data.vocabulary.push({ tag: name, description: description.trim() });
    saveSelection(slug, data);
};

const git = (clone, args) => {
    const result = spawnSync('git', args, { cwd: clone, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : null;
};

// Файлы, которые менял PR на этой голове, — по ним правило, применённое в PR, привязывается к сообществам
const prFiles = (clone, data, ref, pr, head) => {
    const key = `${pr}@${head}`;
    if (data.prFiles[key]) return data.prFiles[key];
    const commit = resolveCommit(clone, head);
    const base = commit && git(clone, ['merge-base', ref, commit])?.trim();
    const names = base ? git(clone, ['diff', '--name-only', base, commit]) : null;
    if (names === null) return [];
    data.prFiles[key] = names.split('\n').filter(Boolean);
    return data.prFiles[key];
};

// Файл треда, из которого правило выучено: сам комментарий человека или корень его треда
const bindLessonFiles = async (bitbucket, repo, data, lessons) => {
    const missing = lessons.filter((lesson) => !data.lessonFiles[lesson.id]);
    const byPr = Map.groupBy(missing, (lesson) => lesson.source?.pr ?? null);
    for (const [prId, group] of byPr) {
        if (!prId) {
            for (const lesson of group) data.lessonFiles[lesson.id] = [];
            continue;
        }
        let comments;
        try {
            comments = new Map((await bitbucket.listComments(repo, prId)).map((comment) => [comment.id, comment]));
        } catch {
            continue;
        }
        const pathOf = (id) => {
            for (let comment = comments.get(id), depth = 0; comment && depth < 20; comment = comments.get(comment.parent?.id), depth++) {
                if (comment.inline?.path) return comment.inline.path;
            }
            return null;
        };
        for (const lesson of group) data.lessonFiles[lesson.id] = [...new Set((lesson.source.commentIds ?? []).map(pathOf).filter(Boolean))];
    }
};

export const pick = (lessons, keep) => {
    const ids = lessons.filter(keep).map((lesson) => lesson.id);
    const chosen = new Set(ids);
    return { ids, chars: lessons.filter((lesson) => chosen.has(lesson.id)).reduce((sum, lesson) => sum + lessonChars(lesson), 0) };
};

// Подбор всех стратегий. applications — запуски ревью до этой головы: { pr, head, appliedLessons }
export const selectRules = ({ lessons, data, prTags, prPaths, graph, applications, filesOf }) => {
    const picks = {};
    const tagged = new Set(prTags);
    const byTags = (lesson) => (data.lessonTags[lesson.id] ?? []).some((tag) => tag === GENERAL || tagged.has(tag));
    picks.T = pick(lessons, byTags);
    const prCommunities = {};
    if (graph) {
        // Пути правила: файл его треда и файлы PR, где оно уже применялось
        const runs = new Map(lessons.map((lesson) => [lesson.id, new Set()]));
        for (const run of applications) {
            for (const id of run.appliedLessons) runs.get(id)?.add(`${run.pr}@${run.head}`);
        }
        const lessonPaths = new Map(lessons.map((lesson) => [lesson.id, [...(data.lessonFiles[lesson.id] ?? []), ...[...runs.get(lesson.id)].flatMap(filesOf)]]));
        for (const [variant, key, union] of [['native', 'G', 'TG'], ['nolibs', 'G2', 'TG2']]) {
            if (!data.graph.includes(variant)) continue;
            const communityOf = (path) => graph.files[path]?.[variant];
            const pathsToCommunities = (paths) => new Set(paths.map(communityOf).filter((id) => id !== undefined));
            const own = pathsToCommunities(prPaths);
            prCommunities[variant] = [...own].sort((a, b) => a - b);
            const byGraph = (lesson) => [...pathsToCommunities(lessonPaths.get(lesson.id))].some((id) => own.has(id));
            picks[key] = pick(lessons, byGraph);
            picks[union] = pick(lessons, (lesson) => byTags(lesson) || byGraph(lesson));
        }
    }
    return { picks, prCommunities };
};

const journaled = (repo, pr, head) => loadJsonl(JOURNAL_FILE).some((row) => row.repo === repo && row.pr === pr && row.head === head);

// Одна строка журнала на голову PR, до ревью: подбор считается по тому, что было известно до этого запуска.
// Ошибки отсюда не должны мешать ревью — вызывающий их только пишет в журнал
export const shadowSelect = async (ctx, repo, pr, { clone, head, diff, files, description }) => {
    const data = loadSelection(repo.slug);
    if (!data || journaled(repo.slug, pr.id, head)) return;
    const lessons = loadMemory(repo.slug);
    if (!lessons.length) return;
    const workDir = join(ctx.workDir, 'rule-selection');
    const ref = defaultRef(clone);
    await tagMissingLessons(ctx.config, repo, workDir, data, lessons);
    await bindLessonFiles(ctx.bitbucket, repo, data, lessons);
    const commits = (git(clone, ['log', '--format=%s', `${ref}..${resolveCommit(clone, head)}`]) ?? '').split('\n').filter(Boolean).slice(0, 50);
    const answer = await runTagging(ctx.config, workDir, 'rule-pr-tags', repo.slug, prTagsPrompt(repo, data.vocabulary, { pr, description, commits, files, diff }), PR_TAGS_SCHEMA);
    const prTags = cleanTags(answer.tags ?? [], data.vocabulary, { allowGeneral: false });
    let graph = null;
    try {
        graph = await loadGraph(repo, clone, ref, data.graph);
    } catch (error) {
        log(`${repo.slug}: подбор правил — ${error.message}; стратегии по графу в этот раз пропущены`);
    }
    // Эталон текущей головы ещё не известен; запуски этой же головы из прошлого не берём, чтобы не подсказывать ответ
    const applications = loadStats().filter((entry) => entry.repo === repo.slug && Array.isArray(entry.appliedLessons) && !(entry.pr === pr.id && entry.head === head));
    const filesOf = (key) => {
        const [prId, prHead] = key.split('@');
        return prFiles(clone, data, ref, Number(prId), prHead);
    };
    const { picks, prCommunities } = selectRules({ lessons, data, prTags, prPaths: files, graph, applications, filesOf });
    data.prFiles[`${pr.id}@${head}`] = files;
    saveSelection(repo.slug, data);
    appendJsonl(JOURNAL_FILE, {
        at: new Date().toISOString(),
        repo: repo.slug,
        pr: pr.id,
        head,
        tags: prTags,
        communities: prCommunities,
        graphCommit: graph?.commit ?? null,
        total: pick(lessons, () => true),
        picks,
    });
    log(`${repo.slug}#${pr.id}: подбор правил (тень) — теги ${prTags.join(', ') || 'нет'}; ${Object.entries(picks).map(([key, value]) => `${STRATEGIES[key]} ${value.ids.length}`).join(', ')} из ${lessons.length}`);
};
