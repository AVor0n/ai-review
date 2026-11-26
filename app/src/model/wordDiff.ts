// Пословная разница по наибольшей общей подпоследовательности — перенос WordDiff из menubar/MemoryReviewView.swift.
// Слово — вместе с пробелами после него, чтобы текст собирался обратно без потерь
export const words = (text: string): string[] => {
    const result: string[] = [];
    let current = '';
    for (const char of text) {
        if (!/\s/.test(char) && /\s$/.test(current)) {
            result.push(current);
            current = '';
        }
        current += char;
    }
    if (current) result.push(current);
    return result;
};

// Индексы слов a и b, которые вошли в общую подпоследовательность
export const common = (a: string[], b: string[]) => {
    const x = a.map((word) => word.trim());
    const y = b.map((word) => word.trim());
    const lengths = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lengths[i][j] = x[i] === y[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    const keptA = new Set<number>();
    const keptB = new Set<number>();
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
        if (x[i] === y[j]) {
            keptA.add(i++);
            keptB.add(j++);
        } else if (lengths[i + 1][j] >= lengths[i][j + 1]) i++;
        else j++;
    }
    return { a: keptA, b: keptB };
};

export type Run = { text: string; code: boolean; marked: boolean };

// Markdown здесь не разобрать: подсветка режет `код` на части. Обратные кавычки обрабатываем сами — они переключают моноширинный шрифт.
// Пробел между двумя изменёнными словами тоже подсвечен: правка читается одним куском, а не пятнами
export const runs = (list: string[], kept: Set<number>): Run[] => {
    const result: Run[] = [];
    let code = false;
    const push = (text: string, marked: boolean) => {
        if (!text) return;
        const last = result[result.length - 1];
        if (last && last.code === code && last.marked === marked) last.text += text;
        else result.push({ text, code, marked });
    };
    list.forEach((word, index) => {
        const spaces = word.length - word.trimEnd().length;
        const core = word.slice(0, word.length - spaces);
        const changed = !kept.has(index);
        let segment = '';
        for (const char of core) {
            if (char === '`') {
                push(segment, changed);
                segment = '';
                code = !code;
            } else segment += char;
        }
        push(segment, changed);
        push(word.slice(word.length - spaces), changed && index + 1 < list.length && !kept.has(index + 1));
    });
    return result;
};

// «Было» и «станет»: в «было» — чего не осталось, в «станет» — что появилось. У склеенного правила «было» несколько,
// и новое сравнивается с ними всеми подряд
export const changeDiff = (before: string[], after: string) => {
    const afterWords = words(after);
    const sources = before.map(words);
    const kept = common(sources.flat(), afterWords).b;
    return { before: sources.map((source) => runs(source, common(source, afterWords).a)), after: runs(afterWords, kept) };
};
