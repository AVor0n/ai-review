import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ask } from '@tauri-apps/plugin-dialog';

// Системное подтверждение поверх поповера. Пока оно открыто, Rust не прячет поповер при потере фокуса (set_modal),
// а после — фокус возвращается поповеру, чтобы клик мимо него снова его прятал
export const confirm = async (message: string, options: Parameters<typeof ask>[1]) => {
    await invoke('set_modal', { open: true }).catch(() => {});
    try {
        return await ask(message, options);
    } finally {
        await invoke('set_modal', { open: false }).catch(() => {});
        getCurrentWindow()
            .setFocus()
            .catch(() => {});
    }
};
