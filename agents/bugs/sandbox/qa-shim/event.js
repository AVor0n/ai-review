import { qa } from './log.js';
export const listen = async (name, handler) => { (qa.listeners[name] ??= []).push(handler); return () => { qa.listeners[name] = qa.listeners[name].filter((h) => h !== handler); }; };
qa.emit = (name, payload) => (qa.listeners[name] ?? []).forEach((h) => h({ payload }));
