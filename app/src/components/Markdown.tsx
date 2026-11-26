import { Fragment } from 'react';
import type { Run } from '../model/wordDiff';

// Строчный Markdown правил и причин: `код` и **жирный** — как inlineMarkdown в MemoryReviewView.swift
export const Markdown = ({ text }: { text: string }) => (
    <>
        {text.split(/(`[^`]+`)/).map((part, index) =>
            part.startsWith('`') && part.endsWith('`') && part.length > 1 ? (
                <code key={index}>{part.slice(1, -1)}</code>
            ) : (
                <Fragment key={index}>{part.split(/\*\*([^*]+)\*\*/).map((piece, inner) => (inner % 2 ? <strong key={inner}>{piece}</strong> : piece))}</Fragment>
            ),
        )}
    </>
);

// Строка «было / станет» с подсветкой: в «было» — <del>, в «станет» — <ins>
export const DiffLine = ({ runs, mark }: { runs: Run[]; mark: 'del' | 'ins' }) => (
    <span>
        {runs.map((run, index) => {
            const text = run.code ? <code>{run.text}</code> : run.text;
            if (!run.marked) return <Fragment key={index}>{text}</Fragment>;
            return mark === 'del' ? <del key={index}>{text}</del> : <ins key={index}>{text}</ins>;
        })}
    </span>
);
