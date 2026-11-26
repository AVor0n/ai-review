// Подтверждения действий, связь с сервисом и служебные ошибки приложения
const rebaseTail = 'После rebase прогоняются проверки и делается push --force-with-lease. Работа идёт в отдельной копии, перед изменениями создаётся резервная ветка.';
const conflicts = 'будут конфликты — их разрешит Claude, а если вариант неочевиден, rebase отменится';

export const app = {
    service: {
        notRunning: 'PR Reviewer: сервис не запущен',
        notResponding: 'PR Reviewer: сервис не отвечает',
        noAnswer: 'Сервис не ответил',
        streamBroken: 'Поток событий оборвался',
        unreachable: 'Сервис не отвечает на 127.0.0.1',
        streamStatus: 'Поток событий ответил {status}',
        downWsl: 'Нет ответа от сервиса в WSL ({address}). Откройте терминал Ubuntu — сервис запускается вместе с WSL. Если он не поднялся, выполните в PowerShell команду ниже.',
        downMac: 'Нет ответа от {address}. Запустите сервис командой ниже или установите заново через ./install.sh.',
        missingNotice: 'PR Reviewer: сервис не установлен в WSL',
        missing: 'В WSL нет сервиса PR Reviewer (юнита pr-reviewer-api), перезапускать нечего. Установите его по инструкции в README, раздел «Installing on Windows 11 (WSL2)».',
        noWslNotice: 'PR Reviewer: в Windows нет WSL',
        noWsl: 'Сервис PR Reviewer работает в WSL, а в Windows не нашлось WSL или дистрибутива Linux. Установите Ubuntu в WSL2 и сервис по инструкции в README, раздел «Installing on Windows 11 (WSL2)».',
    },
    confirm: {
        fix: {
            title: 'Доработать #{pr} по замечаниям?',
            text: 'Claude перенесёт ветку {source} на свежую {destination}, исправит открытые замечания ({open}), закоммитит, прогонит проверки и, если они прошли, сделает push --force-with-lease. Работа идёт в отдельной копии и может занять до часа. Перед изменениями создаётся резервная ветка.',
            ok: 'Доработать',
        },
        rebase: {
            title: 'Сделать rebase #{pr} на {destination}?',
            text: {
                one: `Ветка {source} отстала от {destination} на {count} коммит. ${rebaseTail}`,
                few: `Ветка {source} отстала от {destination} на {count} коммита. ${rebaseTail}`,
                many: `Ветка {source} отстала от {destination} на {count} коммитов. ${rebaseTail}`,
                other: `Ветка {source} отстала от {destination} на {count} коммита. ${rebaseTail}`,
            },
            textConflicts: {
                one: `Ветка {source} отстала от {destination} на {count} коммит, ${conflicts}. ${rebaseTail}`,
                few: `Ветка {source} отстала от {destination} на {count} коммита, ${conflicts}. ${rebaseTail}`,
                many: `Ветка {source} отстала от {destination} на {count} коммитов, ${conflicts}. ${rebaseTail}`,
                other: `Ветка {source} отстала от {destination} на {count} коммита, ${conflicts}. ${rebaseTail}`,
            },
            ok: 'Rebase',
        },
        arch: {
            title: 'Архитектурное ревью #{pr}?',
            text: '{agent} оценит решение целиком: цель, альтернативы с ценой переделки, где можно проще, серьёзные риски. Это займёт до часа. Отчёт останется только здесь, в PR ничего не публикуется.',
            ok: 'Запустить',
        },
    },
    trayIcon: {
        missing: 'Нет иконки {id}',
        drawFailed: 'Не удалось нарисовать значок',
        saveFailed: 'Не удалось сохранить значок',
    },
};
