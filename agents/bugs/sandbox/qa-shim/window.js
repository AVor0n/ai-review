import { qa } from './log.js';
export const getCurrentWindow = () => ({ setTitle: async (title) => { qa.windowTitle = title; }, close: async () => { qa.windowClosed = true; } });
