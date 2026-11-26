import { useSyncExternalStore } from 'react';

// Долгие операции с памятью — разбор, применение, откат, изучение истории — живут вне листа, как состояние AppModel в SwiftUI:
// лист можно закрыть и открыть снова, а итог дождётся его
export type MemoryJobs = {
    reviewing?: number;
    applying?: boolean;
    restoring?: boolean;
    learning?: boolean;
    reviewError?: string;
    historyError?: string;
    applied?: string;
    restored?: string;
    learnResult?: string;
};

let state: Record<string, MemoryJobs> = {};
const listeners = new Set<() => void>();

export const updateJobs = (slug: string, patch: Partial<MemoryJobs>) => {
    state = { ...state, [slug]: { ...state[slug], ...patch } };
    listeners.forEach((listener) => listener());
};

export const jobsOf = (slug: string) => state[slug] ?? {};

export const useJobs = (slug: string) =>
    useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () => state[slug] ?? EMPTY,
    );

const EMPTY: MemoryJobs = {};

// Итог команды — её последняя строка вывода: «План применён: правил было 67, стало 59»
export const lastLine = (output: string | undefined) => output?.trim().split('\n').filter(Boolean).pop();
