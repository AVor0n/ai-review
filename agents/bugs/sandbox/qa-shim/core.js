import { qa } from './log.js';
// token.js пишет sandbox.sh при запуске: токен API песочницы, в git его нет
import { token } from './token.js';
export const invoke = async (cmd, args, options) => {
    if (cmd === 'save_image') { qa.images = [...(qa.images ?? []), { bytes: args.length, name: options?.headers?.['x-file-name'] }]; return null; }
    if (cmd === 'set_tray_icon') qa.trayFrames = [...(qa.trayFrames ?? []), args.frames];
    qa.invokes.push({ cmd, args: cmd === 'set_tray_icon' ? { frames: args.frames.length } : args });
    if (cmd === 'set_tray_menu') qa.menu = args.items;
    if (cmd === 'set_tray_tooltip') qa.tooltip = args.tooltip;
    if (cmd === 'show_notification') qa.notifications.push(args);
    if (cmd === 'api_token') return token;
    if (cmd === 'taskbar_dark') return false;
    if (cmd === 'code_available') return true;
    return null;
};
