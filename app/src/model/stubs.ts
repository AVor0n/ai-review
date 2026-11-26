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

// Остался неперенесённым только «Журнал»
export type StubTarget = { kind: 'tab'; tab: 'log' };

export type Command = { text: string; note: string };
export type Stub = { tab: TabId; title: string; text: string; commands: Command[] };

// Где сервис в WSL: путь к bin/pr-reviewer и папке журналов отдаёт /health
export type CliEnv = { cli: string; logDir: string };

// install.sh не кладёт pr-reviewer в PATH: команда — полный путь, домашняя папка сокращается до ~
const shorten = (path: string) => path.replace(/^\/(?:home\/[^/]+|root)(?=\/)/, '~');

const logCommands = (cli: string, logDir: string): Command[] => [
    { text: `${cli} status`, note: 'состояние и последние ревью' },
    { text: `tail -f ${shorten(logDir)}/worker.log`, note: 'журнал сервиса' },
];

const content = (_target: StubTarget, cli: string, logDir: string): Omit<Stub, 'text'> => ({ tab: 'log', title: 'Журнал', commands: logCommands(cli, logDir) });

export const stub = (target: StubTarget, platform: 'mac' | 'win', env: CliEnv): Stub => {
    const { tab, title, commands } = content(target, shorten(env.cli), env.logDir);
    return platform === 'mac'
        ? { tab, title, text: 'Экран переедет в следующих версиях. Пока он есть в старом окне', commands: [] }
        : { tab, title, text: 'Экран переедет в следующих версиях. Пока — через командную строку в WSL', commands };
};
