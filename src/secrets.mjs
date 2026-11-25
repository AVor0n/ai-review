import { readSecret, secretSavedAt, writeSecret } from './platform.mjs';

// Секреты для фоновых запусков: id → service и account из config.json. Наружу — только «есть / нет» и дата сохранения
export const secretTargets = (config) => ({
    bitbucket: { service: config.bitbucket.keychainService, account: config.bitbucket.email },
    ...Object.fromEntries(Object.entries(config.agents).filter(([, agent]) => agent.keychainService).map(([id, agent]) => [id, { service: agent.keychainService, account: id }])),
});

export const secretStatus = (config) =>
    Object.entries(secretTargets(config)).map(([id, { service, account }]) => ({
        id,
        service,
        present: Boolean(readSecret(service, account) || (id !== 'bitbucket' && readSecret(service))),
        savedAt: secretSavedAt(service),
    }));

// Токены моделей читаются без аккаунта: на Mac пишем в уже заведённую запись, а не рядом с ней
export const saveSecret = (config, id, value) => {
    const target = secretTargets(config)[id];
    if (!target) throw new Error(`Нет секрета ${id}: ${Object.keys(secretTargets(config)).join(', ')}`);
    if (!value?.trim()) throw new Error('Пустое значение — ничего не сохранено');
    return writeSecret(target.service, target.account, value.trim(), { reuseAccount: id !== 'bitbucket' });
};
