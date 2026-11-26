import type { Messages } from '../core';
import type { app as Ru } from '../ru/app';

const rebaseTail = 'After the rebase, checks run, then push --force-with-lease. The work happens in a separate working copy; a backup branch is created first.';
const conflicts = 'There will be conflicts: Claude will resolve them, and if the choice isn’t obvious, the rebase is cancelled.';

export const app: Messages<typeof Ru> = {
    service: {
        notRunning: 'PR Reviewer: service not running',
        notResponding: 'PR Reviewer: service not responding',
        noAnswer: 'The service didn’t respond',
        streamBroken: 'The event stream was interrupted',
        unreachable: 'The service isn’t responding on 127.0.0.1',
        streamStatus: 'The event stream responded with {status}',
        downWsl: 'No response from the service in WSL ({address}). Open the Ubuntu terminal: the service starts with WSL. If it didn’t start, run the command below in PowerShell.',
        downMac: 'No response from {address}. Start the service with the command below or reinstall it with ./install.sh.',
    },
    confirm: {
        fix: {
            title: 'Fix findings in #{pr}?',
            text: 'Claude will rebase {source} onto the latest {destination}, fix the open findings ({open}), commit, run checks and, if they pass, push --force-with-lease. The work happens in a separate working copy and may take up to an hour. A backup branch is created first.',
            ok: 'Fix',
        },
        rebase: {
            title: 'Rebase #{pr} onto {destination}?',
            text: {
                one: `{source} is {count} commit behind {destination}. ${rebaseTail}`,
                other: `{source} is {count} commits behind {destination}. ${rebaseTail}`,
            },
            textConflicts: {
                one: `{source} is {count} commit behind {destination}. ${conflicts} ${rebaseTail}`,
                other: `{source} is {count} commits behind {destination}. ${conflicts} ${rebaseTail}`,
            },
            ok: 'Rebase',
        },
        arch: {
            title: 'Architecture review #{pr}?',
            text: '{agent} will assess the solution as a whole: the goal, alternatives with the cost of rework, where it could be simpler, serious risks. It takes up to an hour. The report stays here only; nothing is posted to the PR.',
            ok: 'Start',
        },
    },
    trayIcon: {
        missing: 'No icon {id}',
        drawFailed: 'Couldn’t draw the icon',
        saveFailed: 'Couldn’t save the icon',
    },
};
