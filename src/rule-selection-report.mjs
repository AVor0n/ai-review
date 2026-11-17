import { loadMemory } from './memory.mjs';
import { JOURNAL_FILE, STRATEGIES } from './rule-selection.mjs';
import { loadJsonl, loadOutcomes, loadStats } from './store.mjs';

// Замечание публикуется через несколько минут после строки журнала; время замечания восстанавливается из outcomes с точностью до часа
const POSTED_SLACK_MS = 45 * 60_000;

const percent = (part, whole) => (whole ? `${Math.round((100 * part) / whole)}%` : '—');

// Эталон — appliedLessons запусков ревью этой головы; строгий эталон — правила, на которых основаны замечания
export const selectionReport = ({ repo = null, since = null } = {}) => {
    const rows = loadJsonl(JOURNAL_FILE).filter((row) => (!repo || row.repo === repo) && (!since || row.at >= since));
    const stats = loadStats().filter((entry) => Array.isArray(entry.appliedLessons));
    const outcomes = loadOutcomes().filter((outcome) => outcome.lessons?.length);
    const repos = [];
    for (const slug of [...new Set(rows.map((row) => row.repo))]) {
        const own = rows.filter((row) => row.repo === slug).sort((a, b) => a.at.localeCompare(b.at));
        const strict = new Map(own.map((row) => [row, new Set()]));
        for (const outcome of outcomes.filter((item) => item.repo === slug)) {
            const posted = new Date(Date.parse(outcome.at) - outcome.hours * 3600_000 + POSTED_SLACK_MS).toISOString();
            const row = own.findLast((candidate) => candidate.pr === outcome.pr && candidate.at <= posted);
            if (row) outcome.lessons.forEach((id) => strict.get(row).add(id));
        }
        const keys = ['all', ...Object.keys(STRATEGIES).filter((key) => own.some((row) => row.picks[key]))];
        const totals = Object.fromEntries(keys.map((key) => [key, { heads: 0, hits: 0, reference: 0, picked: 0, strictHits: 0, strictReference: 0, count: 0, chars: 0 }]));
        const misses = [];
        let runs = 0;
        for (const row of own) {
            const rowRuns = stats.filter((entry) => entry.repo === slug && entry.pr === row.pr && entry.head === row.head && entry.at >= row.at);
            runs += rowRuns.length;
            for (const key of keys) {
                const choice = key === 'all' ? row.total : row.picks[key];
                if (!choice) continue;
                const ids = key === 'all' ? null : new Set(choice.ids);
                const has = (id) => !ids || ids.has(id);
                const total = totals[key];
                total.heads++;
                total.count += choice.ids.length;
                total.chars += choice.chars;
                for (const run of rowRuns) {
                    total.reference += run.appliedLessons.length;
                    total.hits += run.appliedLessons.filter(has).length;
                    total.picked += choice.ids.length;
                }
                for (const id of strict.get(row)) {
                    total.strictReference++;
                    if (has(id)) total.strictHits++;
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
        const table = ['| Стратегия | Полнота | Строгая полнота | Точность | Правил в среднем | Знаков в среднем |', '|---|---|---|---|---|---|'];
        for (const [key, total] of Object.entries(totals)) {
            if (!total.heads) continue;
            const name = key === 'all' ? 'Вся память' : STRATEGIES[key];
            const strictLine = total.strictReference ? `${percent(total.strictHits, total.strictReference)} (${total.strictHits}/${total.strictReference})` : '—';
            table.push(`| ${name} | ${percent(total.hits, total.reference)} (${total.hits}/${total.reference}) | ${strictLine} | ${percent(total.hits, total.picked)} | ${Math.round(total.count / total.heads)} | ${Math.round(total.chars / total.heads)} |`);
        }
        lines.push(table.join('\n'));
        if (misses.length) {
            lines.push(['Потери строгого эталона:', ...misses.map((miss) => `- PR #${miss.pr} (${miss.head}) · ${STRATEGIES[miss.strategy]} · [${miss.id}] ${texts.get(miss.id) ?? '(правила уже нет в памяти)'}`)].join('\n'));
        }
    }
    return `${lines.join('\n\n')}\n`;
};
