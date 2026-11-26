import { qa } from './log.js';
const item = (kind) => ({ new: async (options) => ({ kind, ...options }) });
export const MenuItem = item('item');
export const CheckMenuItem = item('check');
export const PredefinedMenuItem = item('separator');
export const Menu = { new: async ({ items }) => ({ popup: async () => { qa.popup = items; } }) };
