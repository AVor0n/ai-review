import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Данные сервиса лежат в HOME: подменяем его до импорта
const home = mkdtempSync(join(tmpdir(), 'pr-reviewer-test-'));
process.env.HOME = home;
// На Linux пути данных идут от XDG-переменных, если они заданы: убираем, чтобы тест не задел настоящие данные
for (const name of ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME']) delete process.env[name];
const { DATA_DIR, GIT_ROOT, IS_MAC } = await import('../src/platform.mjs');
const { exportData, foreignPaths } = await import('../src/transfer.mjs');
after(() => rmSync(home, { recursive: true, force: true }));

test('пути с другой машины в config.json называются по месту', () => {
    const config = { repos: [{ slug: 'a', source: '/Users/me/repos/a' }, { slug: 'b', source: '/home/me/b' }], bitbucket: { email: 'me@example.com' } };
    assert.deepEqual(foreignPaths(config), IS_MAC ? [{ path: 'repos[1].source', value: '/home/me/b' }] : [{ path: 'repos[0].source', value: '/Users/me/repos/a' }]);
});

test('экспорт: данные, графы и манифест, без рабочих папок, очередей и файлов идущего процесса', async () => {
    const write = (path, text = '{}') => {
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, text);
    };
    write(join(DATA_DIR, 'state.json'));
    write(join(DATA_DIR, 'memory/backend.json'));
    write(join(DATA_DIR, 'tmp/work/file.txt'));
    write(join(DATA_DIR, 'queue/backend-1-claude.json'));
    write(join(DATA_DIR, 'arch/queue/job.json'));
    write(join(DATA_DIR, 'arch/state/backend-1.json'));
    write(join(DATA_DIR, 'worker.pid'), '123');
    write(join(GIT_ROOT, 'graphs/backend/snapshots/abc.json'));
    write(join(GIT_ROOT, 'graphs/backend/src/Main.java'), 'class Main {}');
    const { execFileSync } = await import('node:child_process');
    const archive = join(home, 'export.tar.gz');
    exportData(archive);
    const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n').filter((name) => name && !name.endsWith('/'));
    // config.json берётся из папки сервиса: есть ли он, зависит от машины
    const inside = names.map((name) => name.replace(/^pr-reviewer-export\//, '')).filter((name) => name !== 'config.json').sort();
    assert.deepEqual(inside, ['data/arch/state/backend-1.json', 'data/memory/backend.json', 'data/state.json', 'graphs/backend/snapshots/abc.json', 'manifest.json']);
    const manifest = JSON.parse(execFileSync('tar', ['-xzOf', archive, 'pr-reviewer-export/manifest.json'], { encoding: 'utf8' }));
    assert.equal(manifest.format, 1);
    assert.equal(readFileSync(join(DATA_DIR, 'worker.pid'), 'utf8'), '123');
});
