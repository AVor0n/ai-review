// Тема — системная; data-theme на <html> оставлен под будущую настройку «светлая / тёмная / как в системе»
export const followSystemTheme = () => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.setAttribute('data-theme', query.matches ? 'dark' : 'light');
    apply();
    query.addEventListener('change', apply);
};
