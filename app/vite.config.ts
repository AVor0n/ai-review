import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Порт и папка — как ждёт tauri.conf.json. Стили берутся из дизайн-системы product/design/web — она вне app/
export default defineConfig({
    plugins: [react()],
    clearScreen: false,
    server: { port: 1420, strictPort: true, fs: { allow: ['..'] } },
    build: { target: 'es2022', outDir: 'dist' },
});
