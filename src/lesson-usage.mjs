import { loadOutcomes, loadStats } from './store.mjs';

// Окно в запусках ревью репозитория: младше — правило не вытесняется, столько же без применений — признак бесполезности
export const EVICTION_WINDOW = 50;

// У правил, склеенных из добавленных вручную, источника нет — тогда список склеенных лежит в самом правиле
export const mergedFrom = (lesson) => lesson.source?.mergedFrom ?? lesson.mergedFrom ?? [];

// Сколько раз правило повлияло на ревью и чем кончились замечания, которые на нём основаны.
// last — номер последнего запуска с применением, runTimes — время каждого учтённого запуска
export const countLessonUsage = (slug, lessons) => {
    const usage = new Map();
    const row = (id) => {
        if (!usage.has(id)) usage.set(id, { applied: 0, findings: 0, addressed: 0, dismissed: 0, last: -1 });
        return usage.get(id);
    };
    // Склеенное правило наследует срабатывания тех, из которых его собрали
    const alias = new Map(lessons.flatMap((lesson) => mergedFrom(lesson).map((old) => [old, lesson.id])));
    const current = (id) => alias.get(id) ?? id;
    const stats = loadStats().filter((entry) => entry.repo === slug && Array.isArray(entry.appliedLessons));
    stats.forEach((entry, index) => {
        for (const id of new Set(entry.appliedLessons.map(current))) {
            row(id).applied++;
            row(id).last = index;
        }
    });
    for (const outcome of loadOutcomes().filter((item) => item.repo === slug && item.lessons?.length)) {
        for (const id of new Set(outcome.lessons.map(current))) {
            row(id).findings++;
            if (outcome.outcome === 'addressed') row(id).addressed++;
            else if (outcome.outcome === 'dismissed' || outcome.outcome === 'unchanged') row(id).dismissed++;
        }
    }
    return { usage, since: stats[0]?.at ?? null, runs: stats.length, runTimes: stats.map((entry) => entry.at) };
};

export const plural = (count, [one, few, many]) =>
    `${count} ${count % 10 === 1 && count % 100 !== 11 ? one : [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100) ? few : many}`;
const times = (count) => plural(count, ['раз', 'раза', 'раз']);
const ofRuns = (count) => plural(count, ['запуск', 'запуска', 'запусков']);

// Кого вытеснить при переполнении: сначала правила, замечания по которым чаще отклоняли, чем исправляли; потом не применявшиеся
// за последние EVICTION_WINDOW запусков; потом с наименьшей долей применений, при равенстве — старшее.
// Счёт по appliedLessons, а не по замечаниям: запрещающие правила замечаний не дают, но применяются.
// Ручные, исправленные и слишком молодые правила не вытесняются; если кандидатов не хватает, short — сколько не вытеснено
export const pickEvictions = (lessons, overflow, { usage, runs, runTimes }) => {
    if (overflow <= 0) return { victims: [], short: 0 };
    const candidates = lessons
        .filter((lesson) => !lesson.manual && !lesson.edited)
        .map((lesson) => {
            const age = runTimes.filter((at) => at >= lesson.at).length;
            const counts = usage.get(lesson.id) ?? { applied: 0, addressed: 0, dismissed: 0, last: -1 };
            return { lesson, age, counts, rate: age ? counts.applied / age : 0 };
        })
        .filter(({ age }) => age >= EVICTION_WINDOW)
        .map((candidate) => {
            const { applied, addressed, dismissed, last } = candidate.counts;
            if (dismissed >= 2 && dismissed > addressed) return { ...candidate, rank: 0, reason: `замечания по правилу отклонили ${times(dismissed)}, исправили ${times(addressed)}` };
            if (runs - 1 - last >= EVICTION_WINDOW) return { ...candidate, rank: 1, reason: `не применялось за последние ${ofRuns(EVICTION_WINDOW)}${applied ? ` (всего применялось ${times(applied)})` : ''}` };
            return { ...candidate, rank: 2, reason: `применялось реже остальных: ${times(applied)} за ${ofRuns(candidate.age)}` };
        })
        .sort((a, b) => a.rank - b.rank || a.rate - b.rate || a.lesson.at.localeCompare(b.lesson.at));
    const victims = candidates.slice(0, overflow).map(({ lesson, reason }) => ({ lesson, reason }));
    return { victims, short: overflow - victims.length };
};
