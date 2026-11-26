import type { Messages } from '../core';
import type { alerts as Ru } from '../ru/alerts';

export const alerts: Messages<typeof Ru> = {
    findings: '{levels} in {repo} #{pr} · {agent}',
    comments: { one: '{count} comment in {repo} #{pr}', other: '{count} comments in {repo} #{pr}' },
    comment: 'Comment in {repo} #{pr}',
    reply: 'Reply in {repo} #{pr}',
    newPr: 'New PR {repo} #{pr}',
    newCommits: 'New commits in {repo} #{pr}',
    closed: { title: 'PR {repo} #{pr} closed', body: 'Merged or declined' },
    fix: { done: 'Fix finished: {repo} #{pr}', failed: 'Fix failed: {repo} #{pr}', counts: 'Fixed {fixed}, not fixed {skipped}' },
    rebase: { done: 'Rebase finished: {repo} #{pr}', failed: 'Rebase failed: {repo} #{pr}' },
    runError: 'PR Reviewer: pass failed',
    stall: { title: 'Review pass stuck', body: 'The service hasn’t responded for {duration}: git or the network seems stuck. You can stop the pass in Overview.' },
    review: { title: '{agent} finished reviewing {repo} #{pr}', findings: 'Findings: {levels}', clean: 'No findings' },
    settings: {
        kinds: {
            findings: { title: 'Model findings', detail: 'New findings in PRs' },
            comments: { title: 'Team comments', detail: 'New threads and team replies, except yours' },
            reviews: { title: 'Review finished', detail: 'A model reviewed a PR: how many findings, or “clean”' },
            updates: { title: 'PR updates', detail: 'New commits, new and closed PRs' },
            fixes: { title: 'Fix and rebase', detail: 'Result: pushed, conflicts, checks failed' },
            errors: { title: 'Service errors', detail: 'First error in a row and a stuck pass' },
        },
        levelAll: 'All',
        repoInherit: 'Same as all',
        repoOwn: 'Custom · {count} of {total}',
        muted: 'Muted',
        mutedUntil: 'Muted until {time}',
    },
};
