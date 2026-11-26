import type { Messages } from '../core';
import type { tray as Ru } from '../ru/tray';

export const tray: Messages<typeof Ru> = {
    mute: {
        line: 'Notifications: muted',
        lineUntil: 'Notifications: muted until {time}',
        unmute: 'Unmute notifications',
        mute: 'Mute notifications',
        muteOther: 'Mute for a different time',
    },
    status: {
        stall: 'Pass stuck for {minutes} min',
        reviewing: 'Reviewing: {target}',
        checking: 'Checking PRs',
        fixing: 'Fixing · Claude',
        paused: 'Background review is off',
        error: 'The last pass failed',
        idle: 'Idle',
        soon: 'Next pass within a minute',
        next: 'Next pass in {minutes} min',
    },
    tooltip: {
        offline: 'PR Reviewer: service not responding',
        stall: 'PR Reviewer: review pass stuck for {minutes} min. You can stop it in Overview',
        reviews: 'PR Reviewer: {count} reviews running',
        review: 'PR Reviewer: reviewing {target}',
        fixing: 'PR Reviewer: fixing PR findings · Claude',
        paused: 'PR Reviewer: paused',
        checking: 'PR Reviewer: checking PRs',
        error: 'PR Reviewer: error',
        idle: 'PR Reviewer: idle',
        unreviewed: 'PRs not reviewed on the current commit: {count}',
        important: 'Important findings awaiting fix: {count}',
    },
    menu: {
        offline: 'Service not responding',
        reviews: '{count} reviews running:',
        stop: 'Stop review',
        stopAll: 'Stop all reviews',
        runNow: 'Check now',
        resume: 'Turn on background review',
        pause: 'Turn off background review',
        quit: 'Quit PR Reviewer',
    },
};
