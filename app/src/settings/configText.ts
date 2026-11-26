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

export const configProblem = (text: string) => {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    const problems = validate(schema, value);
    if (!problems.length) return null;
    return problems.length > 1 ? `${problems[0]} (и ещё ${problems.length - 1})` : problems[0];
};

