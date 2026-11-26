// Сегменты поповера. Журнал — не вкладка, а лист в «Настройках» (решение пользователя, Q49, #52)
export const TABS = ['overview', 'backlog', 'stats', 'settings'] as const;

export type TabId = (typeof TABS)[number];
