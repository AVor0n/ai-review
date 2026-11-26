import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Сборка qa: вызовы Tauri заменены журналом в window.__qa, остальное — как vite.config.ts. sandbox.sh кладёт файл в app/ выгрузки
const shim = (name: string) => new URL(`./qa-shim/${name}.js`, import.meta.url).pathname;
const tauri = { core: 'api/core', event: 'api/event', window: 'api/window', menu: 'api/menu', dialog: 'plugin-dialog', opener: 'plugin-opener', notification: 'plugin-notification' };

export default defineConfig({
    plugins: [react()],
    define: { __BUILD__: JSON.stringify({ commit: process.env.QA_COMMIT ?? 'qa', date: new Date().toISOString(), dirty: false }) },
    clearScreen: false,
    resolve: { alias: Object.fromEntries(Object.entries(tauri).map(([name, module]) => [`@tauri-apps/${module}`, shim(name)])) },
    server: { port: Number(process.env.QA_WINDOW_PORT ?? 1421), strictPort: true, fs: { allow: ['..'] } },
});
