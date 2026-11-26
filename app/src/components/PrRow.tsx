import { agentName, canTest, findingUrl, importantFindings, isTaskBranch } from '../model/derive';
import { archAction, fixAction, modelButtons, qaAction, threadsCounter, updatedText, type RowAction } from '../model/row';
import type { Data, PullRequest } from '../model/types';
import { Icon } from './Icon';

export type RowHandlers = {
    review: (repo: string, pr: number, agent: string) => void;
    open: (url: string) => void;
    fix: (repo: string, pr: PullRequest, rebase: boolean) => void;
    arch: (repo: string, pr: PullRequest) => void;
    report: (kind: 'fix' | 'arch' | 'qa', repo: string, pr: number) => void;
};

const ActionButton = ({ action, onClick }: { action: RowAction; onClick: () => void }) => {
    const classes = ['row-action', action.color && `row-action--${action.color}`, action.stale && 'row-action--stale'].filter(Boolean).join(' ');
    return (
        <button className={classes} disabled={action.disabled} title={action.hint} onClick={onClick}>
            <Icon id={action.spinner ? 'i-spinner' : action.icon} />
        </button>
    );
};

export const PrRow = ({ data, repo, pr, now, on }: { data: Data; repo: string; pr: PullRequest; now: Date; on: RowHandlers }) => {
    const important = importantFindings(data, repo, pr.id);
    const worst = important.length ? important.reduce((a, b) => (b.level < a.level ? b : a)) : null;
    const threads = threadsCounter(data, repo, pr, now);
    const fix = fixAction(data, repo, pr);
    const arch = archAction(data, repo, pr);
    const updated = updatedText(pr, now);
    return (
        <div className={`pr-row${pr.draft ? ' pr-row--dimmed' : ''}`}>
            <div className="pr-row__models">
                {modelButtons(data, repo, pr, now).map((button) => (
                    <button key={button.agent} className={`model-button model--${button.agent}`} data-state={button.state} title={button.hint} disabled={button.busy} onClick={() => on.review(repo, pr.id, button.agent)}>
                        <span className="model-mark" />
                        {button.badge && (
                            <span className={`model-badge model-badge--${button.badge}`}>
                                <Icon id={button.badge === 'limit' ? 'i-badge-hourglass' : 'i-badge-pause'} />
                            </span>
                        )}
                    </button>
                ))}
            </div>
            <div className="pr-row__main" title="Открыть PR в Bitbucket" onClick={() => on.open(pr.url)}>
                <div className="pr-row__title">
                    <span className="pr-row__id">#{pr.id}</span>
                    <span className="pr-row__name">{pr.title}</span>
                </div>
                <div className="pr-row__meta">{[pr.author, `${pr.source} → ${pr.destination}`].filter(Boolean).join(' · ')}</div>
            </div>
            {worst && (
                <button
                    className={`tag ${worst.level === 'P0' ? 'tag--red' : 'tag--orange'}`}
                    title={`${important.map((finding) => `${finding.level} · ${agentName(data.config, finding.agent)}: ${finding.title}`).join('\n')}\n\nСтроки ещё не правили. Нажмите, чтобы открыть замечание`}
                    onClick={() => on.open(findingUrl(pr, worst))}
                >
                    {important.length > 1 ? `${worst.level} +${important.length - 1}` : worst.level}
                </button>
            )}
            {pr.draft ? (
                <span className="tag">Draft</span>
            ) : (
                !isTaskBranch(data.config, pr.source) && (
                    <span className="tag" title={`Ветка ${pr.source} не подходит под шаблон веток задач, поэтому фоновое ревью этот PR пропускает. Запустить ревью можно кликом по иконке модели. Шаблон — в настройках`}>
                        Untracked
                    </span>
                )
            )}
            <span className={`threads${threads.kind === 'open' ? '' : ` threads--${threads.kind}`}`} title={threads.hint}>
                <Icon id={threads.kind === 'clean' ? 'i-bubble-check-fill' : threads.kind === 'resolved' ? 'i-bubble-check' : 'i-bubble'} />
                {threads.kind !== 'clean' && <span>{threads.label}</span>}
            </span>
            <ActionButton
                action={fix}
                onClick={() => (fix.click === 'report' ? on.report('fix', repo, pr.id) : fix.click === 'none' ? undefined : on.fix(repo, pr, fix.click === 'start-rebase'))}
            />
            <ActionButton action={arch} onClick={() => (arch.click === 'report' ? on.report('arch', repo, pr.id) : on.arch(repo, pr))} />
            {canTest(data.config, repo) && <ActionButton action={qaAction(data, repo, pr)} onClick={() => on.report('qa', repo, pr.id)} />}
            <span className="pr-row__updated" title={updated.hint}>
                {updated.text}
            </span>
        </div>
    );
};
