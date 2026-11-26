import { moreMessages, type Banner, type BannerAction } from '../model/banners';
import { Icon, InlineCode } from './Icon';

// Свёрнутым виден только первый баннер, остальные — под строкой «Ещё N сообщений»
export const Banners = ({
    items,
    expanded,
    onToggle,
    onAction,
    onClose,
}: {
    items: Banner[];
    expanded: boolean;
    onToggle: () => void;
    onAction: (action: BannerAction) => void;
    onClose: (close: NonNullable<Banner['close']>) => void;
}) => {
    if (!items.length) return null;
    const shown = expanded ? items : items.slice(0, 1);
    return (
        <div className="banners">
            {shown.map((banner) => (
                <div key={banner.id} className={`banner banner--${banner.variant}`} role={banner.variant === 'critical' ? 'alert' : undefined}>
                    <Icon id={banner.icon} className="icon banner__icon" />
                    <div className="banner__body">
                        <div className="banner__title">{banner.title}</div>
                        <div className={`banner__text${banner.clamp ? ' banner__text--clamp' : ''}`}>
                            <InlineCode text={banner.text} />
                        </div>
                        {banner.command && <div className="banner__command selectable">{banner.command}</div>}
                    </div>
                    {(banner.actions.length > 0 || banner.close) && (
                        <div className="banner__actions">
                            {banner.actions.map((action) => (
                                <button key={action.label} className={`link-button${action.destructive ? ' link-button--destructive' : ''}`} onClick={() => onAction(action)}>
                                    {action.label}
                                </button>
                            ))}
                            {banner.close && (
                                <button className="close-button" title={banner.close.hint} onClick={() => onClose(banner.close!)}>
                                    <Icon id="i-close" />
                                </button>
                            )}
                        </div>
                    )}
                </div>
            ))}
            {items.length > 1 && (
                <button className="banner-more" onClick={onToggle}>
                    {expanded ? 'Свернуть' : moreMessages(items.length - 1)}
                    <Icon id={expanded ? 'i-chevron-up' : 'i-chevron-down'} />
                </button>
            )}
        </div>
    );
};
