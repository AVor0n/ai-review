import { loadMemory } from './memory.mjs';
import { graphPicks, historyBefore } from './rule-binding.mjs';
import { loadCommunitiesAt } from './rule-graph.mjs';
import { JOURNAL_FILE, STRATEGIES, lessonChars, loadSelection } from './rule-selection.mjs';
import { loadJsonl, loadOutcomes, loadStats } from './store.mjs';

// Замечание публикуется через несколько минут после строки журнала; время замечания восстанавливается из outcomes с точностью до часа
const POSTED_SLACK_MS = 45 * 60_000;

const percent = (part, whole) => (whole ? `${Math.round((100 * part) / whole)}%` : '—');
const points = (part, base, whole) => (whole ? `${part >= base ? '+' : '−'}${Math.abs(Math.round((100 * (part - base)) / whole))} п.п.` : '—');

const gain = (total) =>
    `${points(total.hits, total.baseHits, total.reference)}, строгая ${points(total.strictHits, total.baseStrictHits, total.strictReference)}, +${Math.round((total.count - total.baseCount) / total.heads)} правил`;

// Стратегии по графу пересчитываются по записанным в строку файлам PR и снимку графа той сборки, с текущей привязкой
// и только по данным до строки: так привязку можно менять, не перезапуская сбор. Без снимка остаётся записанный подбор
const recompute = ({ row, data, stats, outcomes, texts }) => {
    const graph = data && loadCommunitiesAt(row.repo, row.graphCommit);
    const files = row.files ?? data?.prFiles?.[`${row.pr}@${row.head}`];
    if (!graph || !files) return row.picks;
    const history = historyBefore({ stats, outcomes, prFiles: data.prFiles, repo: row.repo, before: row.at });
    const lessonIds = row.total.ids;
    const { picks } = graphPicks({ lessonIds, tIds: row.picks.T.ids, lessonFiles: data.lessonFiles, variants: data.graph, files: graph.files, prPaths: files, history, currentPr: row.pr });
    const average = row.total.chars / Math.max(1, lessonIds.length);
    const size = (id) => row.sizes?.[id] ?? (texts.has(id) ? lessonChars({ id, text: texts.get(id) }) : average);
    return { T: row.picks.T, ...Object.fromEntries(Object.entries(picks).map(([key, ids]) => [key, { ids, chars: Math.round(ids.reduce((sum, id) => sum + size(id), 0)) }])) };
};

// Эталон — appliedLessons запусков ревью этой головы; строгий эталон — правила, на которых основаны замечания.
// «При размере T» — подбор обрезан по рангу до числа правил, которое выбрал T: иначе больший подбор выигрывает полноту даром.
// TG начинается с правил T, обрезка дала бы ровно T, поэтому для TG — прирост к T на тех же головах: base* — показатели T
const UNIONS = new Set(['TG', 'TG2']);
export const selectionReport = ({ repo = null, since = null } = {}) => {
    const rows = loadJsonl(JOURNAL_FILE).filter((row) => (!repo || row.repo === repo) && (!since || row.at >= since));
    const stats = loadStats().filter((entry) => Array.isArray(entry.appliedLessons));
    const outcomes = loadOutcomes().filter((outcome) => outcome.lessons?.length);
    const repos = [];
    for (const slug of [...new Set(rows.map((row) => row.repo))]) {
        const data = loadSelection(slug);
        const texts = new Map(loadMemory(slug).map((lesson) => [lesson.id, lesson.text]));
        const own = rows.filter((row) => row.repo === slug).sort((a, b) => a.at.localeCompare(b.at));
        const strict = new Map(own.map((row) => [row, new Set()]));
        for (const outcome of outcomes.filter((item) => item.repo === slug)) {
            const posted = new Date(Date.parse(outcome.at) - outcome.hours * 3600_000 + POSTED_SLACK_MS).toISOString();
            const row = own.findLast((candidate) => candidate.pr === outcome.pr && candidate.at <= posted);
            if (row) outcome.lessons.forEach((id) => strict.get(row).add(id));
        }
        const keys = ['all', ...Object.keys(STRATEGIES)];
        const totals = Object.fromEntries(keys.map((key) => [key, { heads: 0, hits: 0, reference: 0, picked: 0, equalHits: 0, strictHits: 0, strictReference: 0, count: 0, chars: 0, baseHits: 0, baseStrictHits: 0, baseCount: 0 }]));
        const misses = [];
        let runs = 0;
        for (const row of own) {
            const picks = recompute({ row, data, stats, outcomes, texts });
            const limit = row.picks.T.ids.length;
            const rowRuns = stats.filter((entry) => entry.repo === slug && entry.pr === row.pr && entry.head === row.head && entry.at >= row.at);
            runs += rowRuns.length;
            for (const key of keys) {
                const choice = key === 'all' ? row.total : picks[key];
                if (!choice) continue;
                const ids = new Set(choice.ids);
                const equal = new Set(key === 'all' ? [] : choice.ids.slice(0, limit));
                const base = new Set(UNIONS.has(key) ? row.picks.T.ids : []);
                const total = totals[key];
                total.heads++;
                total.count += choice.ids.length;
                total.baseCount += base.size;
                total.chars += choice.chars;
                for (const run of rowRuns) {
                    total.reference += run.appliedLessons.length;
                    total.hits += run.appliedLessons.filter((id) => ids.has(id)).length;
                    total.equalHits += run.appliedLessons.filter((id) => equal.has(id)).length;
                    total.baseHits += run.appliedLessons.filter((id) => base.has(id)).length;
                    total.picked += choice.ids.length;
                }
                for (const id of strict.get(row)) {
                    total.strictReference++;
                    if (base.has(id)) total.baseStrictHits++;
                    if (ids.has(id)) total.strictHits++;
                    else misses.push({ pr: row.pr, head: row.head, strategy: key, id });
                }
            }
        }
        repos.push({ repo: slug, heads: own.length, runs, totals, misses });
    }
    return { since, repos };
};

export const renderSelectionReport = (report) => {
    if (!report.repos.length) return 'Журнал подбора правил пуст: строки появляются перед ревью новых голов в репозиториях со словарём тегов.\n';
    const lines = [`# Подбор правил (тень)${report.since ? ` · с ${report.since.slice(0, 10)}` : ''}`];
    for (const { repo, heads, runs, totals, misses } of report.repos) {
        const texts = new Map(loadMemory(repo).map((lesson) => [lesson.id, lesson.text]));
        lines.push(`## ${repo} · голов ${heads}, запусков ревью ${runs}`);
        const table = ['| Стратегия | Полнота | При размере T / прирост к T | Строгая полнота | Точность | Правил в среднем | Знаков в среднем |', '|---|---|---|---|---|---|---|'];
        for (const [key, total] of Object.entries(totals)) {
            if (!total.heads) continue;
            const name = key === 'all' ? 'Вся память' : STRATEGIES[key];
            const equal = key === 'all' ? '—' : UNIONS.has(key) ? gain(total) : percent(total.equalHits, total.reference);
            const strictLine = total.strictReference ? `${percent(total.strictHits, total.strictReference)} (${total.strictHits}/${total.strictReference})` : '—';
            table.push(`| ${name} | ${percent(total.hits, total.reference)} (${total.hits}/${total.reference}) | ${equal} | ${strictLine} | ${percent(total.hits, total.picked)} | ${Math.round(total.count / total.heads)} | ${Math.round(total.chars / total.heads)} |`);
        }
        lines.push(table.join('\n'));
        if (misses.length) {
            lines.push(['Потери строгого эталона:', ...misses.map((miss) => `- PR #${miss.pr} (${miss.head}) · ${STRATEGIES[miss.strategy]} · [${miss.id}] ${texts.get(miss.id) ?? '(правила уже нет в памяти)'}`)].join('\n'));
        }
    }
    return `${lines.join('\n\n')}\n`;
};
