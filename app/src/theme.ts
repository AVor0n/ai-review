// Тема из настроек: «Системная» следует за macOS и Windows, «Светлая» и «Тёмная» — постоянно. Выбор общий для всех окон приложения
export type Theme = 'system' | 'light' | 'dark';

const KEY = 'pr-reviewer.theme';
const query = window.matchMedia('(prefers-color-scheme: dark)');

export const loadTheme = (): Theme => {
    try {
        const value = localStorage.getItem(KEY);
        return value === 'light' || value === 'dark' ? value : 'system';
    } catch {
        return 'system';
    }
};

const apply = () => {
    const theme = loadTheme();
    document.documentElement.setAttribute('data-theme', theme === 'system' ? (query.matches ? 'dark' : 'light') : theme);
};

export const setTheme = (theme: Theme) => {
    try {
        localStorage.setItem(KEY, theme);
    } catch {
        // Без хранилища тема живёт до перезапуска
    }
    apply();
};

export const followSystemTheme = () => {
    apply();
    query.addEventListener('change', apply);
    // Окно просмотра и поповер — разные страницы: тему, выбранную в одной, подхватывает другая
    window.addEventListener('storage', (event) => event.key === KEY && apply());
};
