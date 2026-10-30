import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { anchorFinding, parseDiff } from '../src/diff.mjs';

const files = parseDiff(readFileSync(new URL('fixtures/change.diff', import.meta.url), 'utf8'));
const anchor = (path, line, side = 'new') => anchorFinding(files, { path, line, side });

test('добавленная строка привязывается к новой версии', () => {
    assert.deepEqual(anchor('src/list.ts', 12), { inline: { path: 'src/list.ts', to: 12 }, track: { path: 'src/list.ts', line: 12 }, moved: false });
});

test('неизменённая строка получает оба номера, иначе Bitbucket привяжет комментарий к файлу', () => {
    assert.deepEqual(anchor('src/list.ts', 14).inline, { path: 'src/list.ts', from: 13, to: 14 });
});

test('удалённая строка привязывается к старой версии и отслеживается по месту удаления', () => {
    assert.deepEqual(anchor('src/list.ts', 12, 'old'), { inline: { path: 'src/list.ts', from: 12 }, track: { path: 'src/list.ts', line: 12 }, moved: false });
});

test('строка вне диффа сдвигается к ближайшей строке из диффа', () => {
    const result = anchor('src/list.ts', 30);
    assert.equal(result.moved, true);
    assert.deepEqual(result.inline, { path: 'src/list.ts', from: 40, to: 41 });
});

test('у удалённого файла замечание к старой версии, отслеживать в новой негде', () => {
    assert.deepEqual(anchor('src/old.ts', 1), { inline: { path: 'src/old.ts', from: 1 }, track: null, moved: false });
});

test('переименованный файл находится по старому и новому пути', () => {
    assert.deepEqual(anchor('src/new.ts', 1, 'old'), { inline: { path: 'src/new.ts', from: 1 }, track: { path: 'src/renamed.ts', line: 1 }, moved: false });
    assert.deepEqual(anchor('./src/renamed.ts', 2).inline, { path: 'src/renamed.ts', from: 2, to: 2 });
});

test('файла нет в диффе', () => {
    assert.equal(anchor('src/missing.ts', 1), null);
});
