import schema from '../../../schema/config.schema.json';
import { validate } from '../../../src/json-schema.mjs';

// Проверка до записи — та же, что у сервиса (src/json-schema.mjs): битый конфиг остановил бы и фоновое ревью, и приложение
export type Token = { text: string; kind: 'k' | 's' | 'n' | 'b' | 'p' | null };

// Подсветка как у JSONHighlighter: ключи основным, строки и слова кроме true/false вторичным, числа и true/false цветом, знаки третичным
export const highlight = (text: string): Token[] => {
    const tokens: Token[] = [];
    const pattern = /("(?:\\.|[^"\\])*"?)(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|([A-Za-z_]\w*)|([{}[\]:,])/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
        if (match.index > last) tokens.push({ text: text.slice(last, match.index), kind: null });
        if (match[1] !== undefined) {
            tokens.push({ text: match[1], kind: match[2] ? 'k' : 's' });
            if (match[2]) tokens.push({ text: match[2], kind: 'p' });
        } else if (match[3] !== undefined) tokens.push({ text: match[3], kind: 'n' });
        else if (match[4] !== undefined) tokens.push({ text: match[4], kind: 'b' });
        else if (match[5] !== undefined) tokens.push({ text: match[5], kind: 's' });
        else tokens.push({ text: match[6], kind: 'p' });
        last = match.index + match[0].length;
    }
    if (last < text.length) tokens.push({ text: text.slice(last), kind: null });
    return tokens;
};

// Первая синтаксическая ошибка JSON по-русски, со строкой и столбцом: текст движка JS — по-английски и без места
export const jsonSyntaxError = (text: string): string | null => {
    let index = 0;
    const fail = (what: string): never => {
        const before = text.slice(0, index).split('\n');
        throw new Error(`Ошибка JSON в строке ${before.length}, столбце ${before[before.length - 1].length + 1}: ${what}`);
    };
    const space = () => {
        while (index < text.length && ' \t\n\r'.includes(text[index])) index++;
    };
    const string = () => {
        index++;
        while (index < text.length && text[index] !== '"') {
            if (text[index] === '\n') fail('строка не закрыта кавычкой');
            if (text[index] === '\\') {
                index++;
                if (!'"\\/bfnrtu'.includes(text[index] ?? '')) fail('неверная escape-последовательность');
            }
            index++;
        }
        if (index >= text.length) fail('строка не закрыта кавычкой');
        index++;
    };
    const value = (): void => {
        space();
        const char = text[index];
        if (char === undefined) return fail('файл обрывается, ожидается значение');
        if (char === '{') return object();
        if (char === '[') return array();
        if (char === '"') return string();
        const number = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(index));
        if (number && number[0] !== '-') {
            index += number[0].length;
            return;
        }
        const word = /^(true|false|null)\b/.exec(text.slice(index));
        if (word) {
            index += word[0].length;
            return;
        }
        if (char === "'") return fail('строки и ключи — в двойных кавычках');
        if (char === '}' || char === ']') return fail('лишняя запятая или пропущено значение');
        fail('ожидается значение: строка в двойных кавычках, число, true, false, null, объект или массив');
    };
    const object = () => {
        index++;
        space();
        if (text[index] === '}') return void index++;
        for (;;) {
            space();
            if (text[index] === '}') fail('лишняя запятая перед }');
            if (text[index] !== '"') fail('ключ должен быть строкой в двойных кавычках');
            string();
            space();
            if (text[index] !== ':') fail('после ключа ожидается двоеточие');
            index++;
            value();
            space();
            if (text[index] === ',') {
                index++;
                continue;
            }
            if (text[index] === '}') return void index++;
            fail(index >= text.length ? 'файл обрывается, не хватает }' : 'ожидается запятая или }');
        }
    };
    const array = () => {
        index++;
        space();
        if (text[index] === ']') return void index++;
        for (;;) {
            value();
            space();
            if (text[index] === ',') {
                index++;
                space();
                if (text[index] === ']') fail('лишняя запятая перед ]');
                continue;
            }
            if (text[index] === ']') return void index++;
            fail(index >= text.length ? 'файл обрывается, не хватает ]' : 'ожидается запятая или ]');
        }
    };
    try {
        value();
        space();
        if (index < text.length) fail('лишний текст после конца JSON');
        return null;
    } catch (error) {
        return (error as Error).message;
    }
};

export const configProblem = (text: string) => {
    const syntax = jsonSyntaxError(text);
    if (syntax) return syntax;
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return 'Ошибка JSON: файл не читается';
    }
    const problems = validate(schema, value);
    if (!problems.length) return null;
    return problems.length > 1 ? `${problems[0]} (и ещё ${problems.length - 1})` : problems[0];
};

