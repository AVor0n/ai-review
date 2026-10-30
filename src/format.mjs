const LIST_ITEM = /^\s*([-*]|\d+[.)])\s/;

// Bitbucket склеивает список с предыдущим абзацем, если перед ним нет пустой строки
const spaceLists = (text) => {
    const lines = text.trim().split('\n');
    return lines
        .flatMap((line, index) => {
            const previous = lines[index - 1];
            const needsGap = index > 0 && LIST_ITEM.test(line) && previous.trim() !== '' && !LIST_ITEM.test(previous);
            return needsGap ? ['', line] : [line];
        })
        .join('\n');
};

const dropLeadingLabel = (text, label) => text.trim().replace(new RegExp(`^${label}\\s*:\\s*`, 'i'), '');

export const formatFinding = (finding, agent) =>
    [
        `[${finding.level}] ${finding.title.trim().replace(/^\[P\d\]\s*/, '')}`,
        `Сценарий: ${spaceLists(dropLeadingLabel(finding.scenario, 'Сценарий'))}`,
        `Причина в коде и что сделать: ${spaceLists(dropLeadingLabel(finding.fix, 'Причина в коде и что сделать'))}`,
        agent.signature,
    ].join('\n\n');

export const formatReply = (reply, agent) => {
    const comment = spaceLists(reply.comment ?? '');
    if (reply.verdict === 'agree') {
        return [`👍 Согласен, с уточнением: ${dropLeadingLabel(comment, 'Согласен')}`, agent.signature].join('\n\n');
    }
    // Старую проблему не теряем: команда разберёт её из бэклога сервиса, а тред можно закрывать
    const backlog = reply.reason === 'preexisting' ? ['📋 Проблема была до PR — записана в бэклог для отдельной задачи.'] : [];
    return [`Не согласен: ${dropLeadingLabel(comment, 'Не согласен')}`, ...backlog, agent.signature].join('\n\n');
};

// Подпись другой модели сюда нельзя: по подписи определяется автор, и замечание стало бы «общим»
export const confirmationLine = (agent) => `✓ ${agent.shortName} проверил и согласен`;

// Почему модель закрыла свой тред: исправлено на такой-то голове, команда объяснила, что править не нужно, или отложила правку
export const closingLine = (agent, { status, commit, note }) =>
    status === 'fixed'
        ? `✓ Исправлено в ${commit.slice(0, 7)} — ${agent.shortName}`
        : `✓ ${status === 'deferred' ? 'Отложено в бэклог' : 'Закрыто'}: ${note.trim().replace(/\s+/g, ' ').replace(/\.$/, '').slice(0, 200)} — ${agent.shortName}`;
// Пустую строку в конце комментария Markdown отбрасывает, поэтому отступ держит строка с невидимым символом
const TRAILING_GAP = '\u200c';
// Блок отметок: согласия других моделей и строка закрытия треда
const CONFIRMATIONS = /\n\n---\n\n((?:✓ [^\n]+ *(?:\n|$))+)$/;

// Блок согласий в конце комментария; раньше каждое согласие шло под своим разделителем — такие блоки тоже собираем
export const splitConfirmations = (raw) => {
    let body = raw.replace(/[\s\u200b\u200c\u200d]+$/, '');
    const lines = [];
    for (let match = CONFIRMATIONS.exec(body); match; match = CONFIRMATIONS.exec(body)) {
        lines.unshift(...match[1].split('\n').map((line) => line.trim()).filter(Boolean));
        body = body.slice(0, match.index).replace(/[\s\u200b\u200c\u200d]+$/, '');
    }
    return { body, lines };
};

// Согласия идут подряд без пустых строк (жёсткий перенос — два пробела), отступ — только после последнего
export const renderConfirmations = (body, lines) => (lines.length ? `${body}\n\n---\n\n${lines.join('  \n')}\n\n${TRAILING_GAP}` : body);

export const withMark = (raw, line) => {
    const { body, lines } = splitConfirmations(raw);
    return renderConfirmations(body, lines.includes(line) ? lines : [...lines, line]);
};

export const withConfirmation = (raw, agent) => withMark(raw, confirmationLine(agent));
