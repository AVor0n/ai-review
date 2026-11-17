import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runStructured } from './agents.mjs';
import { ensureClone, fetchOrigin, resolveCommit } from './git.mjs';
import { countLessonUsage, mergedFrom } from './lesson-usage.mjs';
import { appendMemoryHistory, loadMemory, loadMemoryHistory, newId, saveMemory } from './memory.mjs';
import { DATA_DIR, TOOL_DIR, appendSpend, readJson, writeJson } from './store.mjs';

// Разбор памяти: модель предлагает склеить дубли, удалить бесполезное и переписать размытое, человек смотрит план
// и применяет его отдельной командой. Правила, добавленные или исправленные вручную, разбор не трогает
const REVIEW_SCHEMA = join(TOOL_DIR, 'schema/memory-review.schema.json');
const planFile = (slug) => join(DATA_DIR, 'memory', `${slug}.review.json`);
const backupFile = (slug, at) => join(DATA_DIR, 'memory', 'backups', `${slug}-${at.replace(/[-:.]/g, '').slice(0, 15)}.json`);
const isProtected = (lesson) => Boolean(lesson.manual || lesson.edited);

// Отпечаток памяти: план применяется, только если с момента разбора память не менялась
const fingerprint = (lessons) =>
    createHash('sha256')
        .update(JSON.stringify(lessons.map((lesson) => [lesson.id, lesson.text])))
        .digest('hex');

// Сколько раз правило повлияло на ревью и чем кончились замечания, которые на нём основаны
export const lessonUsage = (slug) => countLessonUsage(slug, loadMemory(slug));

export const usageLine = (counts) => {
    if (!counts) return 'не срабатывало';
    const parts = [`срабатывало ${counts.applied}`];
    if (counts.findings) parts.push(`замечаний ${counts.findings} (исправлено ${counts.addressed}, отклонено ${counts.dismissed})`);
    return parts.join(', ');
};

// develop — основная ветка в репозиториях команды; origin/HEAD у служебного клона наследуется от локальной копии
// и может указывать на ветку задачи
export const defaultRef = (clone) => {
    if (resolveCommit(clone, 'origin/develop')) return 'origin/develop';
    const head = spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: clone, encoding: 'utf8' });
    return head.status === 0 && head.stdout.trim() ? head.stdout.trim() : 'origin/master';
};

// Имена в `обратных кавычках`, которых больше нет в основной ветке: правило про удалённый код, скорее всего, устарело.
// Пути проверяются как пути, остальное — поиском по содержимому; короткие и общие слова не проверяем
const missingIdentifiers = (clone, ref, text) => {
    const names = [...text.matchAll(/`([^`\s]{4,80})`/g)]
        .map((match) => match[1].replace(/\(.*$/, '').replace(/[.,:;]+$/, ''))
        .filter((name) => /^[\w./$@-]+$/.test(name) && !/^\d+$/.test(name) && !name.includes('*') && !name.startsWith('../'));
    // Имя может быть и файлом, и словом в коде: устаревшим считаем, только если нет ни того, ни другого
    const isPath = (name) => spawnSync('git', ['cat-file', '-e', `${ref}:${name.replace(/^\.\//, '').replace(/\/$/, '')}`], { cwd: clone }).status === 0;
    const inCode = (name) => {
        const term = name.includes('.') && !name.startsWith('.') && !name.includes('/') ? name.split('.').at(-1) : name;
        return spawnSync('git', ['grep', '-q', '-F', '-e', term, ref], { cwd: clone }).status === 0;
    };
    return [...new Set(names)].filter((name) => !isPath(name) && !inCode(name));
};

const reviewPrompt = (repo, lessons, usage, stale) => {
    const tracking = usage.since
        ? `Срабатывания правил считаются с ${usage.since.slice(0, 10)} (запусков ревью с учётом: ${usage.runs}). Ноль срабатываний за короткий срок ещё не значит, что правило бесполезно: удаляй по этому признаку, только если правило ещё и узкое или разовое.`
        : 'Срабатывания правил ещё не считались — оценивай по тексту.';
    const rendered = lessons
        .map((lesson) => {
            const facts = [
                isProtected(lesson) ? 'защищено: добавлено или исправлено человеком, только keep' : null,
                `источник: ${lesson.source?.kind === 'review' ? 'замечание человека в ревью' : lesson.source?.kind === 'reply' ? 'ответ человека модели' : lesson.manual ? 'добавлено вручную' : 'другое'}`,
                usageLine(usage.usage.get(lesson.id)),
                stale.get(lesson.id)?.length ? `в основной ветке не найдено: ${stale.get(lesson.id).map((name) => `\`${name}\``).join(', ')}` : null,
            ].filter(Boolean);
            return `- [${lesson.id}] ${lesson.text}\n  (${facts.join('; ')})`;
        })
        .join('\n');
    return `Ты наводишь порядок в памяти ревьюеров кода репозитория \`${repo.workspace}/${repo.slug}\`. Память — правила, выведенные из ответов команды на прошлые ревью; все они целиком идут в промпт каждого ревью. Лишние правила — шум, который сбивает модель, а память ограничена по размеру. Пиши по-русски.

${tracking}

Правила:

${rendered}

Для каждого правила реши, что с ним делать, и верни \`actions\`. Каждый id должен встретиться ровно в одном действии.

- \`keep\` — правило полезно как есть. \`text\` пустой.
- \`merge\` — несколько правил говорят об одном (дубли, частные случаи одного соглашения): \`ids\` — все склеиваемые, \`text\` — одно правило, которое покрывает их все без потери конкретики (имена классов, файлов, эндпоинтов сохрани).
- \`rewrite\` — правило полезно, но размыто, слишком длинное или с деталями одного PR: \`text\` — новая формулировка, одно-два предложения.
- \`drop\` — правило бесполезно: деталь одного PR, которая не повторится; общая истина программирования, которую модель и так знает; противоречит другому правилу (оставь более позднее или подтверждённое); код, о котором оно, удалён (см. «не найдено» — но проверь по смыслу: имя могло просто встретиться только в тексте правила). \`text\` пустой.

\`reason\` — коротко, почему, по-русски. Защищённые правила — только \`keep\`. Не удаляй правило только за то, что оно узкое: узкое, но верное знание о предметной области (как устроены данные, что задумано) полезно. Сомневаешься — \`keep\`. \`summary\` — 2–3 предложения: что в памяти не так и что меняется.

Ничего не изменяй в файлах. Верни JSON по схеме.`;
};

const validate = (lessons, actions) => {
    const known = new Map(lessons.map((lesson) => [lesson.id, lesson]));
    const seen = new Set();
    const problems = [];
    for (const action of actions) {
        for (const id of action.ids) {
            if (!known.has(id)) problems.push(`неизвестный id ${id}`);
            else if (seen.has(id)) problems.push(`${id} встречается дважды`);
            else if (action.type !== 'keep' && isProtected(known.get(id))) problems.push(`${id} защищено, а предложено ${action.type}`);
            seen.add(id);
        }
        if (action.type === 'merge' && (action.ids.length < 2 || !action.text.trim())) problems.push(`merge ${action.ids.join(', ')}: нужно два правила и новый текст`);
        if (action.type === 'rewrite' && (action.ids.length !== 1 || !action.text.trim())) problems.push(`rewrite ${action.ids.join(', ')}: нужно одно правило и новый текст`);
    }
    // Забытые правила не теряем: всё, о чём модель не сказала, остаётся
    const forgotten = lessons.filter((lesson) => !seen.has(lesson.id)).map((lesson) => lesson.id);
    return { problems, actions: forgotten.length ? [...actions, { type: 'keep', ids: forgotten, text: '', reason: 'модель не дала оценки' }] : actions };
};

export const reviewMemory = async ({ config, repo, workDir }) => {
    const lessons = loadMemory(repo.slug);
    if (lessons.length < 2) throw new Error(`В памяти ${repo.slug} меньше двух правил — разбирать нечего`);
    const clone = ensureClone(repo);
    fetchOrigin(clone);
    const ref = defaultRef(clone);
    const stale = new Map(lessons.map((lesson) => [lesson.id, missingIdentifiers(clone, ref, lesson.text)]));
    const usage = lessonUsage(repo.slug);
    const agentId = config.memory?.agent ?? 'claude';
    mkdirSync(workDir, { recursive: true });
    const startedAt = Date.now();
    const { data, usage: cost } = await runStructured(agentId, config.agents[agentId], {
        cwd: workDir,
        workDir,
        prompt: reviewPrompt(repo, lessons, usage, stale),
        schemaPath: REVIEW_SCHEMA,
    });
    appendSpend('memory-review', repo.slug, agentId, config.agents[agentId], cost, startedAt);
    const { problems, actions } = validate(lessons, data.actions ?? []);
    if (problems.length) throw new Error(`план разбора некорректен: ${problems.join('; ')}`);
    const plan = { at: new Date().toISOString(), repo: repo.slug, fingerprint: fingerprint(lessons), ref, summary: data.summary ?? '', actions, stale: Object.fromEntries([...stale].filter(([, names]) => names.length)), usage: cost };
    writeJson(planFile(repo.slug), plan);
    return plan;
};

export const loadMemoryPlan = (slug) => readJson(planFile(slug), null);

export const isPlanOutdated = (slug, plan) => plan.fingerprint !== fingerprint(loadMemory(slug));

const TYPES = { merge: 'Склеить', rewrite: 'Переписать', drop: 'Удалить', keep: 'Оставить' };

export const renderMemoryPlan = (slug, plan) => {
    const lessons = new Map(loadMemory(slug).map((lesson) => [lesson.id, lesson]));
    const changed = plan.actions.filter((action) => action.type !== 'keep');
    const kept = plan.actions.filter((action) => action.type === 'keep').flatMap((action) => action.ids);
    const outdated = plan.fingerprint !== fingerprint([...lessons.values()]);
    const cost = plan.usage?.costUsd != null ? ` · $${plan.usage.costUsd.toFixed(2)}` : '';
    const lines = [
        `# Разбор памяти ${slug} · ${plan.at.slice(0, 16).replace('T', ' ')}${cost}`,
        outdated ? '> Память изменилась после разбора — применить этот план нельзя, запустите разбор заново.' : null,
        plan.summary,
        `Правил: ${lessons.size} → ${lessons.size - changed.reduce((sum, action) => sum + (action.type === 'drop' ? action.ids.length : action.type === 'merge' ? action.ids.length - 1 : 0), 0)}. Без изменений: ${kept.length}.`,
    ];
    for (const type of ['merge', 'rewrite', 'drop']) {
        const group = changed.filter((action) => action.type === type);
        if (!group.length) continue;
        lines.push(`## ${TYPES[type]} (${group.length})`);
        for (const action of group) {
            const before = action.ids.map((id) => `  - [${id}] ${lessons.get(id)?.text ?? '(нет в памяти)'}`).join('\n');
            lines.push([`- **${action.reason}**`, before, action.text ? `  → ${action.text}` : null].filter(Boolean).join('\n'));
        }
    }
    lines.push(outdated ? '' : `Применить: \`pr-reviewer memory apply ${slug}\`. Отказаться — просто не применять или \`pr-reviewer memory review ${slug} --discard\`.`);
    return `${lines.filter((line) => line !== null).join('\n\n').trim()}\n`;
};

export const discardMemoryPlan = (slug) => rmSync(planFile(slug), { force: true });

export const applyMemoryPlan = (slug) => {
    const plan = loadMemoryPlan(slug);
    if (!plan) throw new Error(`Для ${slug} нет плана разбора — сначала pr-reviewer memory review ${slug}`);
    const lessons = loadMemory(slug);
    if (plan.fingerprint !== fingerprint(lessons)) throw new Error('Память изменилась после разбора — запустите разбор заново');
    const byId = new Map(lessons.map((lesson) => [lesson.id, lesson]));
    const replace = new Map();
    const remove = new Set();
    const at = new Date().toISOString();
    for (const action of plan.actions) {
        if (action.type === 'drop') action.ids.forEach((id) => remove.add(id));
        if (action.type === 'rewrite') replace.set(action.ids[0], { ...byId.get(action.ids[0]), text: action.text.trim(), rewrittenAt: at });
        if (action.type === 'merge') {
            // Источник склеенного правила — первый из склеенных с источником: окно показывает по нему ссылку на PR
            const source = action.ids.map((id) => byId.get(id).source).find(Boolean);
            // Вместе с id склеенных — и те, из которых склеены они сами: иначе повторная склейка теряла бы их срабатывания
            const merged = [...new Set(action.ids.flatMap((id) => [id, ...mergedFrom(byId.get(id))]))];
            replace.set(action.ids[0], { id: newId(), text: action.text.trim(), at, ...(source ? { source: { ...source, mergedFrom: merged } } : { mergedFrom: merged }) });
            action.ids.slice(1).forEach((id) => remove.add(id));
        }
    }
    const next = lessons.filter((lesson) => !remove.has(lesson.id)).map((lesson) => replace.get(lesson.id) ?? lesson);
    // Копия до применения — для отката: разбор удаляет правила, и без копии их было бы не вернуть
    const backup = backupFile(slug, at);
    writeJson(backup, { lessons });
    saveMemory(slug, next);
    const text = (id) => ({ id, text: byId.get(id).text });
    appendMemoryHistory(slug, {
        kind: 'review',
        reason: plan.summary,
        backup,
        fingerprint: fingerprint(next),
        removed: plan.actions.filter((action) => action.type === 'drop').flatMap((action) => action.ids.map((id) => ({ ...text(id), reason: action.reason }))),
        changed: plan.actions.filter((action) => action.type === 'rewrite').map((action) => ({ id: action.ids[0], before: byId.get(action.ids[0]).text, after: action.text.trim(), reason: action.reason })),
        merged: plan.actions
            .filter((action) => action.type === 'merge')
            .map((action) => ({ from: action.ids.map(text), into: { id: replace.get(action.ids[0]).id, text: action.text.trim() }, reason: action.reason })),
    });
    discardMemoryPlan(slug);
    return { before: lessons.length, after: next.length };
};

// Откат последнего применённого разбора. Только если после него память не менялась: иначе выученные позже правила потерялись бы
export const restoreMemory = (slug) => {
    const last = loadMemoryHistory(slug).findLast((entry) => entry.kind === 'review' || entry.kind === 'restore');
    if (!last || last.kind !== 'review') throw new Error(`Для ${slug} нет применённого разбора, который можно откатить`);
    const lessons = loadMemory(slug);
    if (last.fingerprint !== fingerprint(lessons)) throw new Error('Память менялась после разбора — откат потерял бы эти изменения. Посмотрите журнал (memory history) и верните нужное вручную');
    const saved = readJson(last.backup, null)?.lessons;
    if (!Array.isArray(saved)) throw new Error(`Нет копии памяти ${last.backup}`);
    saveMemory(slug, saved);
    const now = new Set(lessons.map((lesson) => lesson.id));
    const then = new Set(saved.map((lesson) => lesson.id));
    appendMemoryHistory(slug, {
        kind: 'restore',
        reason: `откат разбора от ${last.at.slice(0, 16).replace('T', ' ')}`,
        added: saved.filter((lesson) => !now.has(lesson.id)).map((lesson) => ({ id: lesson.id, text: lesson.text })),
        removed: lessons.filter((lesson) => !then.has(lesson.id)).map((lesson) => ({ id: lesson.id, text: lesson.text })),
        changed: saved.flatMap((lesson) => {
            const current = lessons.find((candidate) => candidate.id === lesson.id);
            return current && current.text !== lesson.text ? [{ id: lesson.id, before: current.text, after: lesson.text }] : [];
        }),
    });
    return { before: lessons.length, after: saved.length };
};

const KINDS = { learn: 'Выучено из PR', add: 'Добавлено вручную', edit: 'Исправлено вручную', remove: 'Удалено вручную', evict: 'Вытеснено', review: 'Разбор памяти', restore: 'Откат разбора' };

export const renderMemoryHistory = (slug, limit = 30) => {
    const entries = loadMemoryHistory(slug).slice(-limit).reverse();
    if (!entries.length) return 'Журнал пуст: изменения памяти записываются с этой версии сервиса.\n';
    return `${entries
        .map((entry) => {
            const head = `## ${entry.at.slice(0, 16).replace('T', ' ')} · ${KINDS[entry.kind] ?? entry.kind}${entry.pr ? ` · [PR #${entry.pr}](${entry.url})` : ''}`;
            const why = (reason) => (reason ? ` — ${reason}` : '');
            return [
                head,
                entry.reason || null,
                ...entry.added.map((lesson) => `+ [${lesson.id}] ${lesson.text}`),
                ...entry.removed.map((lesson) => `− [${lesson.id}] ${lesson.text}${why(lesson.reason)}`),
                ...entry.changed.map((change) => `~ [${change.id}]${why(change.reason)}\n  было: ${change.before}\n  стало: ${change.after}`),
                ...(entry.merged ?? []).map((merge) => `⇢ склеено в [${merge.into.id}]${why(merge.reason)}\n${merge.from.map((lesson) => `  было [${lesson.id}]: ${lesson.text}`).join('\n')}\n  стало: ${merge.into.text}`),
                entry.kind === 'review' ? `Откатить: \`pr-reviewer memory restore ${slug}\`` : null,
            ]
                .filter(Boolean)
                .join('\n');
        })
        .join('\n\n')}\n`;
};
