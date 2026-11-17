// Привязка правил к сообществам графа кода (B-24) — чистые функции: ими же считает подбор перед ревью и пересчитывает отчёт.
// Источники: файл треда, из которого правило выучено; файлы замечаний, основанных на правиле;
// сообщества, где правило применялось заметно чаще своей обычной доли. Все файлы PR, где правило применялось, не берём:
// частое правило иначе покрывает почти весь граф и подбирается в каждый PR
export const MIN_LIFT_PRS = 2;
export const MIN_LIFT = 2;

// history — только то, что было известно до текущего PR: runs [{ pr, appliedLessons }], findings [{ pr, path, lessons }], filesOfPr(pr)
const bindLessons = ({ lessonIds, lessonFiles, communityOf, history, currentPr }) => {
    const runs = history.runs.filter((run) => run.pr !== currentPr);
    const findings = history.findings.filter((finding) => finding.pr !== currentPr);
    const appliedIn = new Map();
    const prCommunities = new Map();
    for (const run of runs) {
        if (!prCommunities.has(run.pr)) prCommunities.set(run.pr, new Set(history.filesOfPr(run.pr).map(communityOf).filter((id) => id !== undefined)));
        for (const id of run.appliedLessons) {
            if (!appliedIn.has(id)) appliedIn.set(id, new Set());
            appliedIn.get(id).add(run.pr);
        }
    }
    // PR без известных файлов в доли не участвуют: о его сообществах ничего не известно
    const known = [...prCommunities].filter(([, communities]) => communities.size);
    const touching = new Map();
    for (const [pr, communities] of known) for (const community of communities) (touching.get(community) ?? touching.set(community, new Set()).get(community)).add(pr);

    const binding = new Map();
    for (const lessonId of lessonIds) {
        // Каждый источник — свидетельство с весом 1, сообщество по lift — с весом lift: по сумме ранжируется подбор
        const evidence = new Map();
        const add = (community, weight) => community !== undefined && evidence.set(community, (evidence.get(community) ?? 0) + weight);
        for (const path of lessonFiles[lessonId] ?? []) add(communityOf(path), 1);
        for (const finding of findings) if (finding.lessons.includes(lessonId)) add(communityOf(finding.path), 1);
        const applied = [...(appliedIn.get(lessonId) ?? [])].filter((pr) => prCommunities.get(pr)?.size);
        const share = known.length ? applied.length / known.length : 0;
        if (share) {
            for (const [community, prs] of touching) {
                const hits = applied.filter((pr) => prs.has(pr)).length;
                const lift = hits / prs.size / share;
                if (hits >= MIN_LIFT_PRS && lift >= MIN_LIFT) add(community, lift);
            }
        }
        binding.set(lessonId, evidence);
    }
    return binding;
};

// Ранг правила для PR — сумма весов свидетельств в сообществах PR; 0 — не подбирается
const scoreLessons = (binding, prCommunities) => {
    const scores = new Map();
    for (const [id, evidence] of binding) {
        const score = [...prCommunities].reduce((sum, community) => sum + (evidence.get(community) ?? 0), 0);
        if (score > 0) scores.set(id, score);
    }
    return scores;
};

export const VARIANTS = [
    ['native', 'G', 'TG'],
    ['nolibs', 'G2', 'TG2'],
];

// Подбор по графу и объединение с T, ids — по убыванию ранга: обрезка до размера T берёт начало списка.
// В TG сначала правила, которые выбрали обе стратегии, потом только T, потом только граф
export const graphPicks = ({ lessonIds, tIds, lessonFiles, variants, files, prPaths, history, currentPr }) => {
    const picks = {};
    const communities = {};
    const inT = new Set(tIds);
    for (const [variant, key, union] of VARIANTS) {
        if (!variants.includes(variant)) continue;
        const communityOf = (path) => files[path]?.[variant];
        const own = new Set(prPaths.map(communityOf).filter((id) => id !== undefined));
        communities[variant] = [...own].sort((a, b) => a - b);
        const scores = scoreLessons(bindLessons({ lessonIds, lessonFiles, communityOf, history, currentPr }), own);
        const ranked = lessonIds.filter((id) => scores.has(id)).sort((a, b) => scores.get(b) - scores.get(a));
        picks[key] = ranked;
        picks[union] = [...ranked.filter((id) => inT.has(id)), ...lessonIds.filter((id) => inT.has(id) && !scores.has(id)), ...ranked.filter((id) => !inT.has(id))];
    }
    return { picks, communities };
};

// История для привязки из журналов сервиса: только запуски и исходы раньше момента подбора.
// Файлы PR — по тем его головам, что были отревьюены до этого момента
export const historyBefore = ({ stats, outcomes, prFiles, repo, before }) => {
    const runs = stats.filter((entry) => entry.repo === repo && Array.isArray(entry.appliedLessons) && entry.at < before);
    const filesByPr = new Map();
    for (const run of runs) {
        const paths = filesByPr.get(run.pr) ?? new Set();
        for (const path of prFiles[`${run.pr}@${run.head}`] ?? []) paths.add(path);
        filesByPr.set(run.pr, paths);
    }
    return {
        runs: runs.map(({ pr, appliedLessons }) => ({ pr, appliedLessons })),
        findings: outcomes.filter((outcome) => outcome.repo === repo && outcome.lessons?.length && outcome.path && outcome.at < before).map(({ pr, path, lessons }) => ({ pr, path, lessons })),
        filesOfPr: (pr) => [...(filesByPr.get(pr) ?? [])],
    };
};
