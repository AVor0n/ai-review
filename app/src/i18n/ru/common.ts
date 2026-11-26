// Общие слова и форматы. Ключ other в разделе зарезервирован под формы числа — разделам такое имя не давать
export const common = {
    tabs: { overview: 'Обзор', backlog: 'Бэклог', stats: 'Статистика', settings: 'Настройки' },
    action: { cancel: 'Отмена', close: 'Закрыть', hide: 'Скрыть', more: 'Ещё', copy: 'Скопировать', retry: 'Повторить', open: 'Открыть', save: 'Сохранить', done: 'Готово' },
    language: {
        title: 'Язык',
        hint: 'Как в системе — русский, если система на русском, иначе английский. Комментарии ревью и сообщения сервиса пока на русском.',
        system: 'Как в системе',
        ru: 'Русский',
        en: 'English',
    },
    time: {
        justNow: 'только что',
        until: 'до {time}',
        untilTomorrow: 'до завтра {time}',
        dateAtTime: '{date} в {time}',
        hoursMinutes: '{hours} ч {minutes} мин',
        minutes: '{minutes} мин',
        seconds: '{seconds} с',
        minutesSeconds: '{minutes} мин {seconds} с',
        lessThanHour: '< 1 ч',
        hours: '{hours} ч',
        days: '{days} дн.',
    },
    role: { first: 'первым', second: 'следом', replies: 'ответы' },
    level: {
        P0: { one: '{count} критичное замечание', few: '{count} критичных замечания', many: '{count} критичных замечаний', other: '{count} критичного замечания' },
        P1: { one: '{count} важное замечание', few: '{count} важных замечания', many: '{count} важных замечаний', other: '{count} важного замечания' },
        P2: { one: '{count} среднее замечание', few: '{count} средних замечания', many: '{count} средних замечаний', other: '{count} среднего замечания' },
        P3: { one: '{count} мелкое замечание', few: '{count} мелких замечания', many: '{count} мелких замечаний', other: '{count} мелкого замечания' },
    },
};
