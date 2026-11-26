// Заглушки неперенесённых экранов (решение PM, раздел 6 макета 2026-11-25-tauri-popover.html):
// на Mac экран пока в старом окне, на Windows — команды CLI для терминала Ubuntu в WSL
export const TABS = [
    { id: 'overview', title: 'Обзор' },
    { id: 'backlog', title: 'Бэклог' },
    { id: 'stats', title: 'Статистика' },
    { id: 'log', title: 'Журнал' },
    { id: 'settings', title: 'Настройки' },
] as const;

export type TabId = (typeof TABS)[number]['id'];

export type StubTarget =
    // «Обзор» и «Статистика» уже перенесены
    | { kind: 'tab'; tab: Exclude<TabId, 'overview' | 'stats'> }
    | { kind: 'connect' }
    | { kind: 'token'; id: string; title: string; lifetimeDays: number | null };

export type Command = { text: string; note: string };
export type Stub = { tab: TabId; title: string; text: string; commands: Command[] };

// Где сервис в WSL: путь к bin/pr-reviewer и папке журналов отдаёт /health
export type CliEnv = { cli: string; logDir: string };

// install.sh не кладёт pr-reviewer в PATH: команда — полный путь, домашняя папка сокращается до ~
const shorten = (path: string) => path.replace(/^\/(?:home\/[^/]+|root)(?=\/)/, '~');

const settingsCommands = (cli: string): Command[] => [
    { text: `${cli} repo list`, note: 'подключённые репозитории; add <ссылка> — подключить новый' },
    { text: `${cli} agent set claude --auto on`, note: 'модель, уровень reasoning, участие в фоновом ревью' },
    { text: `${cli} interval 15`, note: 'как часто проверять PR в фоне, в минутах' },
    { text: `${cli} secret status`, note: 'есть ли токены в хранилище' },
    { text: `${cli} help`, note: 'все команды настроек' },
];

const logCommands = (cli: string, logDir: string): Command[] => [
    { text: `${cli} status`, note: 'состояние и последние ревью' },
    { text: `tail -f ${shorten(logDir)}/worker.log`, note: 'журнал сервиса' },
];

const content = (target: StubTarget, cli: string, logDir: string): Omit<Stub, 'text'> => {
    switch (target.kind) {
        case 'tab':
            if (target.tab === 'backlog')
                return {
                    tab: 'backlog',
                    title: 'Бэклог',
                    commands: [
                        { text: `${cli} backlog list`, note: 'записи, ждущие разбора' },
                        { text: `${cli} backlog filed <id>`, note: 'итог разбора: задача заведена; drop <id> — отклонено' },
                    ],
                };
            if (target.tab === 'log') return { tab: 'log', title: 'Журнал', commands: logCommands(cli, logDir) };
            return { tab: 'settings', title: 'Настройки', commands: settingsCommands(cli) };
        case 'connect':
            return { tab: 'settings', title: 'Настройки', commands: [{ text: `${cli} repo add <ссылка>`, note: 'подключить репозиторий по ссылке Bitbucket' }, ...settingsCommands(cli).slice(1)] };
        case 'token':
            return {
                tab: 'settings',
                title: `Токен ${target.title}`,
                commands: [
                    { text: `${cli} secret set ${target.id}`, note: 'сохранить новый токен: значение спросит без показа' },
                    { text: `${cli} token ${target.id} ${target.lifetimeDays || 365}`, note: 'срок жизни в днях — по нему обзор предупреждает заранее' },
                ],
            };
    }
};

export const stub = (target: StubTarget, platform: 'mac' | 'win', env: CliEnv): Stub => {
    const { tab, title, commands } = content(target, shorten(env.cli), env.logDir);
    return platform === 'mac'
        ? { tab, title, text: 'Экран переедет в следующих версиях. Пока он есть в старом окне', commands: [] }
        : { tab, title, text: 'Экран переедет в следующих версиях. Пока — через командную строку в WSL', commands };
};
