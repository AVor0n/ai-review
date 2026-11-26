import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

const git = (args: string) => {
    try {
        return execSync(`git ${args}`, { encoding: 'utf8' }).trim();
    } catch {
        return '';
    }
};

// Строка сборки в «Настройках»: из какого коммита собрано приложение и были ли незакоммиченные правки.
// PR_REVIEWER_BUILD_COMMIT — сборка из выгрузки коммита без .git (чистая копия main или CI): коммит известен снаружи
const commit = process.env.PR_REVIEWER_BUILD_COMMIT;
const build = { commit: commit ?? git('rev-parse HEAD'), date: new Date().toISOString(), dirty: commit ? false : git('status --porcelain -- .') !== '' };

// Порт и папка — как ждёт tauri.conf.json. Стили берутся из дизайн-системы product/design/web — она вне app/
export default defineConfig({
    plugins: [react()],
    clearScreen: false,
    define: { __BUILD__: JSON.stringify(build) },
    server: { port: 1420, strictPort: true, fs: { allow: ['..'] } },
    build: { target: 'es2022', outDir: 'dist' },
});
