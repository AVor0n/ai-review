const LEVELS = ['P0', 'P1', 'P2', 'P3'];

const emptyLevels = () => Object.fromEntries(LEVELS.map((level) => [level, 0]));

const createRow = () => ({
    first: 0,
    second: 0,
    replies: 0,
    findings: { first: Object.fromEntries(LEVELS.map((l) => [l, 0])), second: Object.fromEntries(LEVELS.map((l) => [l, 0])) },
    given: { agree: 0, disagree: 0, skip: 0 },
    received: { agree: 0, disagree: 0 },
    outcomes: { addressed: 0, dismissed: 0, disputed: 0, open: 0 },
    usage: { runs: 0, seconds: 0, tokens: 0, costUsd: 0, priced: 0, pricedFindings: 0 },
});

const sum = (counts) => LEVELS.reduce((total, level) => total + counts[level], 0);
const perReview = (counts, reviews) => (reviews ? (sum(counts) / reviews).toFixed(1) : '—');
const levels = (counts) => LEVELS.map((level) => counts[level]).join('/');

const money = (value) => `$${value.toFixed(2)}`;

const outcomeLine = ({ addressed, dismissed, disputed, open }) => {
    const closed = addressed + dismissed;
    const share = (value) => (closed ? ` (${Math.round((value / closed) * 100)}%)` : '');
    return `${addressed} из ${closed}${share(addressed)}, молча не стали править ${dismissed - disputed}${share(dismissed - disputed)}, оспорили ${disputed}${share(disputed)}, ждут правки ${open}`;
};

const usageLine = ({ usage, outcomes }) => {
    if (!usage.runs) return 'нет данных';
    const parts = [`${Math.round(usage.seconds / usage.runs / 60)} мин и ${Math.round(usage.tokens / usage.runs / 1000)} тыс. токенов на запуск`];
    // Цену за замечание считаем только по запускам, где она известна, иначе среднее занижалось бы
    if (usage.priced) {
        parts.push(`${money(usage.costUsd / usage.priced)} за запуск`);
        if (usage.pricedFindings) parts.push(`${money(usage.costUsd / usage.pricedFindings)} за замечание`);
        if (outcomes.addressed) parts.push(`${money(usage.costUsd / outcomes.addressed)} за исправленное`);
    }
    return parts.join(', ');
};

export const formatStats = (entries, outcomes, state, agents) => {
    const rows = Object.fromEntries(Object.keys(agents).map((id) => [id, createRow()]));
    for (const entry of entries) {
        const row = rows[entry.agent];
        if (!row) continue;
        row[entry.role]++;
        if (entry.role !== 'replies') {
            for (const level of LEVELS) row.findings[entry.role][level] += entry.findings[level] ?? 0;
        }
        for (const { target, verdict } of entry.verdicts) {
            row.given[verdict]++;
            if (rows[target] && verdict !== 'skip') rows[target].received[verdict]++;
        }
        if (entry.usage) {
            row.usage.runs++;
            row.usage.seconds += entry.durationSec ?? 0;
            row.usage.tokens += entry.usage.inputTokens + entry.usage.outputTokens;
            if (entry.usage.costUsd != null) {
                row.usage.costUsd += entry.usage.costUsd;
                row.usage.priced++;
                row.usage.pricedFindings += sum({ ...emptyLevels(), ...entry.findings });
            }
        }
    }
    for (const outcome of outcomes) {
        // Прежний исход «влили без правки, тред открыт» теперь тоже считается отклонённым
        const kind = outcome.outcome === 'unchanged' ? 'dismissed' : outcome.outcome;
        if (rows[outcome.agent] && kind in rows[outcome.agent].outcomes) rows[outcome.agent].outcomes[kind]++;
        if (rows[outcome.agent] && kind === 'dismissed' && outcome.disputed) rows[outcome.agent].outcomes.disputed++;
    }
    for (const repo of Object.values(state.repos ?? {})) {
        for (const pr of Object.values(repo.prs)) {
            for (const finding of pr.findings ?? []) if (rows[finding.agent] && !finding.resolved) rows[finding.agent].outcomes.open++;
        }
    }

    const lines = [`Запусков моделей в статистике: ${entries.length}`, ''];
    for (const [id, row] of Object.entries(rows)) {
        const judged = row.received.agree + row.received.disagree;
        const share = judged ? `${Math.round((row.received.agree / judged) * 100)}%` : '—';
        lines.push(
            `${agents[id].shortName}`,
            `  первым:  ${row.first} ревью, замечаний ${sum(row.findings.first)} (P0/P1/P2/P3 ${levels(row.findings.first)}), ${perReview(row.findings.first, row.first)} на ревью`,
            `  вторым:  ${row.second} ревью, новых замечаний ${sum(row.findings.second)} (P0/P1/P2/P3 ${levels(row.findings.second)}), ${perReview(row.findings.second, row.second)} на ревью`,
            `  замечания проверила другая модель: подтвердила ${row.received.agree}, оспорила ${row.received.disagree} (подтверждено ${share})`,
            `  проверил чужие: согласен ${row.given.agree}, не согласен ${row.given.disagree}, пропустил ${row.given.skip}`,
            `  замечания исправили: ${outcomeLine(row.outcomes)}`,
            `  цена: ${usageLine(row)}`,
            '',
        );
    }
    return lines.join('\n');
};
