// Многоточие посередине: CSS умеет только в конце, а у путей и активности важны и начало, и конец.
// Длина — в символах, под ширину строки листа; полный текст остаётся в подсказке
export const middle = (text: string, max: number) => {
    if (text.length <= max) return text;
    const head = Math.ceil((max - 1) / 2);
    return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`;
};
