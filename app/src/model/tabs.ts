// Сегменты поповера. Журнал — не вкладка, а лист в «Настройках» (решение пользователя, Q49, #52)
export const TABS = [
    { id: 'overview', title: 'Обзор' },
    { id: 'backlog', title: 'Бэклог' },
    { id: 'stats', title: 'Статистика' },
    { id: 'settings', title: 'Настройки' },
] as const;

export type TabId = (typeof TABS)[number]['id'];
