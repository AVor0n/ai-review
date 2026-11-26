import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Данные сервиса лежат в HOME: подменяем его до импорта
process.env.HOME = mkdtempSync(join(tmpdir(), 'pr-reviewer-migrate-'));
const { projectNamesPatch } = await import('../src/migrate.mjs');

const repos = (...slugs) => slugs.map((slug) => ({ workspace: 'team', slug, remote: `git@example.com:team/${slug}.git` }));

test('перенос имён проекта: шаблон веток по частому ключу, QA по прошлым тестированиям, общий префикс', () => {
    const patch = projectNamesPatch(
        { repos: repos('acme-frontend', 'acme-backend', 'acme-android'), agents: {} },
        { branches: ['PROJ-1-a', 'feature/proj-2', 'OTHER-3', 'hotfix'], testedRepos: ['acme-frontend', 'acme-frontend'] },
    );
    assert.deepEqual(patch, { branchPattern: 'PROJ-\\d+', qa: { frontend: 'acme-frontend', backend: 'acme-backend' }, displayPrefix: 'acme-' });
});

test('перенос не трогает заданные значения и ничего не выдумывает без данных', () => {
    const config = { repos: repos('acme-frontend', 'acme-backend'), agents: {}, branchPattern: '.', qa: { frontend: 'acme-frontend', backend: 'acme-backend' }, displayPrefix: '' };
    assert.equal(projectNamesPatch(config, { branches: ['PROJ-1'], testedRepos: ['acme-frontend'] }), null);
    assert.equal(projectNamesPatch({ repos: repos('web'), agents: {} }, { branches: ['hotfix'], testedRepos: [] }), null);
    assert.deepEqual(projectNamesPatch({ repos: repos('web', 'api'), agents: {} }, { branches: [], testedRepos: ['web'] }), { qa: { frontend: 'web' } });
});
