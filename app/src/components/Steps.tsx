import { useEffect, useState } from 'react';
import { parse } from '../model/format';
import { middle } from '../model/middle';
import { Icon } from './Icon';
import { t } from '../i18n';

// Ход доработки или тестирования — перенос FixTimeline из menubar/FixViews.swift: у каждого шага длительность до следующего,
// у текущего — живой таймер и последнее действие модели или проверки
export type Step = { title: string; at: string };

const ACTIVITY_CHARS = 76;

export const stepDuration = (seconds: number) => {
    const total = Math.max(0, Math.floor(seconds));
    return total < 60 ? t('common.time.seconds', { seconds: total }) : t('common.time.minutesSeconds', { minutes: Math.floor(total / 60), seconds: total % 60 });
};

export const Steps = ({ title = t('overview.steps.title'), steps, active, failed, finishedAt, activity }: { title?: string; steps: Step[]; active: boolean; failed: boolean; finishedAt?: string | null; activity?: string | null }) => {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!active) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [active]);
    return (
        <div className="section">
            <div className="section__header">{title}</div>
            <div className="section__card">
                {steps.map((step, index) => {
                    const last = index === steps.length - 1;
                    const current = last && active;
                    const started = parse(step.at);
                    const ended = last ? (active ? new Date(now) : parse(finishedAt)) : parse(steps[index + 1].at);
                    return (
                        <div key={index}>
                            {index > 0 && <div className="row-divider row-divider--marker" />}
                            <div className={`step${current ? ' step--current' : ''}`}>
                                <span className="step__mark" style={last && failed && !active ? ({ '--c': 'var(--orange)' } as React.CSSProperties) : undefined}>
                                    <Icon id={current ? 'i-spinner' : last && failed ? 'i-x-circle-fill' : 'i-check-circle-fill'} />
                                </span>
                                <div className="step__body">
                                    <span className="step__title">{step.title}</span>
                                    {current && activity && (
                                        <span className="step__activity" title={activity}>
                                            {middle(activity, ACTIVITY_CHARS)}
                                        </span>
                                    )}
                                </div>
                                {started && ended && <span className="step__time">{stepDuration((ended.getTime() - started.getTime()) / 1000)}</span>}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
