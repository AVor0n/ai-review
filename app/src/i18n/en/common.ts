import type { Messages } from '../core';
import type { common as Ru } from '../ru/common';

export const common: Messages<typeof Ru> = {
    tabs: { overview: 'Overview', backlog: 'Backlog', stats: 'Stats', settings: 'Settings' },
    action: { cancel: 'Cancel', close: 'Close', hide: 'Hide', more: 'More', copy: 'Copy', retry: 'Retry', open: 'Open', save: 'Save', done: 'Done' },
    language: {
        title: 'Language',
        hint: 'System uses Russian if your system language is Russian, otherwise English. Review comments and service messages are in Russian for now.',
        system: 'System',
        ru: 'Русский',
        en: 'English',
    },
    time: {
        justNow: 'just now',
        until: 'until {time}',
        untilTomorrow: 'until tomorrow {time}',
        dateAtTime: '{date} at {time}',
        hoursMinutes: '{hours} h {minutes} min',
        minutes: '{minutes} min',
        seconds: '{seconds} s',
        minutesSeconds: '{minutes} min {seconds} s',
        lessThanHour: '< 1 h',
        hours: '{hours} h',
        days: '{days} d',
    },
    role: { first: 'first', second: 'second', replies: 'replies' },
    level: {
        P0: { one: '{count} critical finding', other: '{count} critical findings' },
        P1: { one: '{count} important finding', other: '{count} important findings' },
        P2: { one: '{count} medium finding', other: '{count} medium findings' },
        P3: { one: '{count} minor finding', other: '{count} minor findings' },
    },
};
