import { qa } from './log.js';
export const ask = async (message, options) => { qa.asks.push({ message, ...options }); return qa.askAnswer; };
