import { useCallback, useRef, useState } from 'react';
import { errorText, type ApiClient } from './api/client';
import type { ChangeEvent } from './api/events';
import { emptyData, type Config, type Data, type Lesson, type Limit, type PrSnapshot, type Secret, type Status, type WorkerState, type FixState, type ArchState, type QaState } from './model/types';

// Данные обзора: при подключении читаем всё, дальше по событию SSE — только изменившийся ресурс
type Patch = Partial<Data> & { memoryBroken?: Record<string, string> };

const loadMemory = async (api: ApiClient, config: Config): Promise<Patch> => {
    const results = await Promise.all(config.repos.map(async (repo) => ({ slug: repo.slug, result: await api.GET('/memory/{repo}', { params: { path: { repo: repo.slug } } }) })));
    const memory: Record<string, Lesson[]> = {};
    const memoryBroken: Record<string, string> = {};
    for (const { slug, result } of results) {
        if (result.data) memory[slug] = (result.data.lessons ?? []) as Lesson[];
        else if (result.error) memoryBroken[slug] = errorText(result.error);
    }
    return { memory, memoryBroken };
};

const LOADERS: Record<string, (api: ApiClient, current: Data) => Promise<Patch>> = {
    status: async (api) => ({ status: ((await api.GET('/status')).data as Status | undefined) ?? null }),
    config: async (api) => {
        const config = ((await api.GET('/config')).data as Config | undefined) ?? { repos: [], agents: {} };
        const secrets = ((await api.GET('/secrets')).data as Secret[] | undefined) ?? [];
        return { config, secrets, ...(await loadMemory(api, config)) };
    },
    prs: async (api) => ({ snapshots: ((await api.GET('/prs')).data as Record<string, PrSnapshot | null> | undefined) ?? {} }),
    state: async (api) => ({ state: ((await api.GET('/state')).data as WorkerState | undefined) ?? {} }),
    limits: async (api) => ({ limits: ((await api.GET('/limits')).data as Record<string, Limit> | undefined) ?? {} }),
    fixes: async (api) => ({ fixes: ((await api.GET('/fixes')).data as FixState[] | undefined) ?? [] }),
    arch: async (api) => ({ archs: ((await api.GET('/arch')).data as ArchState[] | undefined) ?? [] }),
    qa: async (api) => ({ qas: ((await api.GET('/qa')).data as QaState[] | undefined) ?? [] }),
    memory: (api, current) => loadMemory(api, current.config),
};

export const useData = () => {
    const [data, setData] = useState<Data>(emptyData);
    const [memoryBroken, setMemoryBroken] = useState<Record<string, string>>({});
    const current = useRef(data);
    current.current = data;

    const apply = useCallback((patch: Patch) => {
        const { memoryBroken: broken, ...rest } = patch;
        if (broken) setMemoryBroken(broken);
        setData((previous) => ({ ...previous, ...rest }));
    }, []);

    const load = useCallback(
        async (api: ApiClient, types: string[]) => {
            // Конфиг первым: память и секреты зависят от списка репозиториев
            if (types.includes('config')) apply(await LOADERS.config(api, current.current));
            const patches = await Promise.all(types.filter((type) => type !== 'config' && LOADERS[type]).map((type) => LOADERS[type](api, current.current)));
            for (const patch of patches) apply(patch);
        },
        [apply],
    );

    const onEvent = useCallback(
        // Память читается вместе с конфигом: отдельный загрузчик при подключении видел бы ещё пустой список репозиториев
        (api: ApiClient, event: ChangeEvent) => load(api, event.type === 'connected' ? Object.keys(LOADERS).filter((type) => type !== 'memory') : [event.type]),
        [load],
    );

    // Сохранённые токены меняются вне папки данных (Keychain, хранилище секретов): перечитываем при открытии поповера
    const refreshSecrets = useCallback(async (api: ApiClient) => apply({ secrets: ((await api.GET('/secrets')).data as Secret[] | undefined) ?? current.current.secrets }), [apply]);

    return { data, memoryBroken, onEvent, refreshSecrets };
};
