export const authorOf = (comment, agents) => {
    const raw = comment.content?.raw ?? '';
    for (const [id, agent] of Object.entries(agents)) {
        if (raw.includes(agent.marker)) return id;
    }
    return 'human';
};

export const buildThreads = (comments) => {
    const byId = new Map(comments.map((comment) => [comment.id, comment]));
    const rootIdOf = (comment) => {
        let current = comment;
        while (current.parent && byId.has(current.parent.id)) current = byId.get(current.parent.id);
        return current.parent?.id ?? current.id;
    };

    const threads = new Map();
    for (const comment of comments.filter((c) => !c.parent)) threads.set(comment.id, { root: comment, replies: [] });
    for (const comment of comments.filter((c) => c.parent)) threads.get(rootIdOf(comment))?.replies.push(comment);
    return [...threads.values()];
};

// Свои открытые треды агента: на новой голове или после ответа человека он проверяет, пора ли их закрыть.
// checks — по id корня: голова и последний ответ человека на прошлой проверке
export const ownThreadsToCheck = (comments, agentId, agents, head, checks = {}) =>
    buildThreads(comments)
        .filter(({ root }) => !root.deleted && !root.pending && !root.resolution && authorOf(root, agents) === agentId)
        .map(({ root, replies }) => ({
            root,
            lastHumanReply: Math.max(0, ...replies.filter((reply) => !reply.deleted && authorOf(reply, agents) === 'human').map((reply) => reply.id)),
        }))
        .filter(({ root, lastHumanReply }) => {
            const checked = checks[root.id];
            return !checked || checked.head !== head || lastHumanReply > checked.lastHumanReply;
        });

// Корни тредов, по которым агент ещё не высказался: свои замечания он не проверяет
export const pendingRoots = (comments, agentId, handled, agents) =>
    buildThreads(comments)
        .filter(
            ({ root, replies }) =>
                !root.deleted &&
                !root.pending &&
                authorOf(root, agents) !== agentId &&
                !handled.includes(root.id) &&
                !replies.some((reply) => !reply.deleted && authorOf(reply, agents) === agentId),
        )
        .map(({ root }) => root);

const authorLabel = (comment, agents) => {
    const author = authorOf(comment, agents);
    return author === 'human' ? `человек (${comment.user?.display_name ?? 'неизвестно'})` : agents[author].shortName;
};

const locationLabel = ({ inline }) => {
    if (!inline) return 'общий комментарий';
    if (inline.to) return `${inline.path}:${inline.to} (новая версия)`;
    if (inline.from) return `${inline.path}:${inline.from} (старая версия)`;
    return inline.path;
};

export const renderComments = (comments, agents, pendingIds) => {
    const threads = buildThreads(comments).filter(({ root }) => !root.deleted && !root.pending);
    if (!threads.length) return 'Комментариев в PR пока нет.\n';

    return threads
        .map(({ root, replies }) => {
            const mark = pendingIds.includes(root.id) ? ' · НУЖЕН ТВОЙ ОТВЕТ' : '';
            const head = `### Тред ${root.id} · автор: ${authorLabel(root, agents)} · ${locationLabel(root)}${mark}`;
            const body = root.content?.raw ?? '';
            const answers = replies
                .filter((reply) => !reply.deleted)
                .map((reply) => `> Ответ ${reply.id} · автор: ${authorLabel(reply, agents)}\n>\n${(reply.content?.raw ?? '').replace(/^/gm, '> ')}`);
            return [head, body, ...answers].join('\n\n');
        })
        .join('\n\n---\n\n');
};
