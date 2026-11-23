import { execFileSync } from 'node:child_process';

const API = 'https://api.bitbucket.org/2.0';
const PR_FIELDS = [
    'next',
    'values.id',
    'values.title',
    'values.description',
    'values.draft',
    'values.updated_on',
    'values.author.display_name',
    'values.source.branch.name',
    'values.source.commit.hash',
    'values.destination.branch.name',
    'values.destination.commit.hash',
    'values.comment_count',
    'values.links.html.href',
].join(',');
const COMMENT_FIELDS = [
    'next',
    'values.id',
    'values.parent.id',
    'values.deleted',
    'values.pending',
    'values.content.raw',
    'values.inline',
    'values.user.display_name',
    'values.user.account_id',
    'values.created_on',
    'values.links.html.href',
    'values.resolution.created_on',
].join(',');

const readToken = ({ email, keychainService }) => {
    if (!email) throw new Error('В config.json не заполнен bitbucket.email');
    try {
        return execFileSync('security', ['find-generic-password', '-s', keychainService, '-a', email, '-w'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        throw new Error(`Нет токена Bitbucket в Keychain (service ${keychainService}, account ${email})`);
    }
};

export const createBitbucket = (config) => {
    const auth = `Basic ${Buffer.from(`${config.email}:${readToken(config)}`).toString('base64')}`;

    const send = (url, method, body) =>
        fetch(url.startsWith('http') ? url : `${API}${url}`, {
            method,
            headers: {
                Authorization: auth,
                Accept: 'application/json',
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(30_000),
        });

    // Сеть пропадает при переключении VPN; чтение повторяем, а публикацию нет — повтор мог бы задвоить комментарий
    const sendWithRetry = async (url, method, body) => {
        const attempts = method === 'GET' ? 3 : 1;
        for (let attempt = 1; ; attempt++) {
            try {
                return await send(url, method, body);
            } catch (error) {
                const reason = error.cause?.code ?? error.cause?.message ?? error.message;
                if (attempt >= attempts) throw new Error(`Нет связи с Bitbucket (${reason}), ${method} ${url.split('?')[0]}`);
                await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
            }
        }
    };

    const request = async (url, { method = 'GET', body } = {}) => {
        const response = await sendWithRetry(url, method, body);
        if (response.status === 401) {
            throw new Error(`Bitbucket не принял токен (401): проверьте bitbucket.email в config.json и токен в Keychain (service ${config.keychainService})`);
        }
        if (response.status === 403) {
            throw new Error('Bitbucket запретил запрос (403): у токена нет нужных scope — read:repository, read:pullrequest, write:pullrequest');
        }
        if (!response.ok) {
            const text = (await response.text()).slice(0, 300);
            throw new Error(`Bitbucket ${method} ${url.split('?')[0]}: ${response.status} ${text}`);
        }
        return response.status === 204 ? null : response.json();
    };

    const paginate = async (url) => {
        const values = [];
        for (let next = url; next; ) {
            const page = await request(next);
            values.push(...page.values);
            next = page.next;
        }
        return values;
    };

    const prUrl = (repo, id = '') => `/repositories/${repo.workspace}/${repo.slug}/pullrequests${id === '' ? '' : `/${id}`}`;

    let me = null;
    return {
        // Владелец токена: свои комментарии окно не присылает уведомлениями
        currentUser: async () => (me ??= await request('/user?fields=account_id,display_name')),
        getMainBranch: async (repo) => (await request(`/repositories/${repo.workspace}/${repo.slug}?fields=mainbranch.name`)).mainbranch?.name,
        getRepository: (workspace, slug) => request(`/repositories/${workspace}/${slug}?fields=full_name,slug,links.clone,links.html.href`),
        getPr: (repo, id) =>
            request(`${prUrl(repo, id)}?fields=id,title,description,state,author.display_name,source.branch.name,source.commit.hash,destination.branch.name,links.html.href`),
        getPrOutcome: (repo, id) => request(`${prUrl(repo, id)}?fields=state,source.commit.hash`),
        // История для памяти: свежие PR любого состояния, не больше limit
        listRecentPrs: async (repo, limit) => {
            const values = [];
            let next = `${prUrl(repo)}?state=OPEN&state=MERGED&state=DECLINED&sort=-updated_on&pagelen=50&fields=next,values.id,values.state,values.title,values.comment_count,values.links.html.href`;
            while (next && values.length < limit) {
                const page = await request(next);
                values.push(...page.values);
                next = page.next;
            }
            return values.slice(0, limit);
        },
        listOpenPrs: (repo) => paginate(`${prUrl(repo)}?state=OPEN&pagelen=50&fields=${PR_FIELDS}`),
        listComments: (repo, id) => paginate(`${prUrl(repo, id)}/comments?pagelen=100&fields=${COMMENT_FIELDS}`),
        postComment: (repo, id, body) => request(`${prUrl(repo, id)}/comments`, { method: 'POST', body }),
        deleteComment: (repo, id, commentId) => request(`${prUrl(repo, id)}/comments/${commentId}`, { method: 'DELETE' }),
        resolveComment: (repo, id, commentId) => request(`${prUrl(repo, id)}/comments/${commentId}/resolve`, { method: 'POST' }),
        // Обновляется только повторным POST с тем же key: PUT с API-токеном отвечает 403
        postBuildStatus: (repo, commit, body) => request(`/repositories/${repo.workspace}/${repo.slug}/commit/${commit}/statuses/build`, { method: 'POST', body }),
        updateComment: (repo, id, commentId, raw) => request(`${prUrl(repo, id)}/comments/${commentId}`, { method: 'PUT', body: { content: { raw } } }),
    };
};
