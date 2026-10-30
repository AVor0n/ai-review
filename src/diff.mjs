const stripPrefix = (path) => path.replace(/^[ab]\//, '');

export const parseDiff = (text) => {
    const files = new Map();
    let file = null;
    let inHunk = false;
    let oldLine = 0;
    let newLine = 0;

    for (const line of text.split('\n')) {
        if (line.startsWith('diff --git ')) {
            file = { oldPath: null, newPath: null, oldLines: new Set(), newLines: new Set(), oldToNew: new Map(), context: new Map() };
            inHunk = false;
            continue;
        }
        if (!file) continue;

        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) {
            inHunk = true;
            oldLine = Number(hunk[1]);
            newLine = Number(hunk[2]);
            continue;
        }

        // До первого @@ строки «---»/«+++» — заголовок файла, внутри ханка — удалённая/добавленная строка кода
        if (!inHunk) {
            if (line.startsWith('--- ')) file.oldPath = line === '--- /dev/null' ? null : stripPrefix(line.slice(4));
            if (line.startsWith('+++ ')) {
                file.newPath = line === '+++ /dev/null' ? null : stripPrefix(line.slice(4));
                if (file.newPath) files.set(file.newPath, file);
                if (file.oldPath && !files.has(file.oldPath)) files.set(file.oldPath, file);
            }
            continue;
        }

        if (line.startsWith('+')) file.newLines.add(newLine++);
        else if (line.startsWith('-')) {
            // Удалённая строка в новой версии — место удаления: строка, которая теперь стоит на её месте
            file.oldToNew.set(oldLine, newLine);
            file.oldLines.add(oldLine++);
        } else if (line.startsWith(' ')) {
            file.oldToNew.set(oldLine, newLine);
            file.context.set(newLine, oldLine);
            file.newLines.add(newLine++);
            file.oldLines.add(oldLine++);
        }
    }
    return files;
};

const nearest = (lines, target) => {
    let best = null;
    for (const line of lines) {
        if (best === null || Math.abs(line - target) < Math.abs(best - target)) best = line;
    }
    return best;
};

export const anchorFinding = (files, { path, line, side }) => {
    const normalized = path.replace(/^\.?\//, '');
    const file = files.get(normalized);
    if (!file) return null;

    const useOld = side === 'old' ? file.oldLines.size > 0 : file.newLines.size === 0;
    const lines = useOld ? file.oldLines : file.newLines;
    const anchored = lines.has(line) ? line : nearest(lines, line);
    if (anchored === null) return null;

    const inlinePath = useOld ? (file.oldPath ?? normalized) : (file.newPath ?? normalized);
    // Где искать правку в новой версии: у замечания к удалённой строке — место удаления; у удалённого файла — негде
    const track = !useOld ? { path: inlinePath, line: anchored } : file.newPath ? { path: file.newPath, line: file.oldToNew.get(anchored) } : null;
    // Неизменённую строку Bitbucket привязывает, только если указаны оба номера; с одним показывает комментарий ко всему файлу
    const newLine = useOld ? file.oldToNew.get(anchored) : anchored;
    const isContext = newLine !== undefined && file.context.has(newLine);
    const inline = isContext
        ? { path: file.newPath ?? inlinePath, from: file.context.get(newLine), to: newLine }
        : { path: inlinePath, [useOld ? 'from' : 'to']: anchored };
    return { inline, track, moved: anchored !== line };
};
