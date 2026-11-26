import { qa } from './log.js';
export const openUrl = async (url) => { qa.opened.push(url); };
