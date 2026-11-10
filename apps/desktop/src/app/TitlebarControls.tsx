import { ArrowLeft, ArrowRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { IconButton } from '../components/controls/Button';
import { t } from '../i18n/locale';

export function TitlebarControls({
  canBack,
  canForward,
  back,
  forward,
  collapsed,
  canToggle,
  toggle,
}: {
  canBack: boolean;
  canForward: boolean;
  back: () => unknown;
  forward: () => unknown;
  collapsed: boolean;
  canToggle: boolean;
  toggle: () => unknown;
}) {
  return (
    <nav className="titlebar-leading titlebar-navigation" aria-label={t('app.navigation')}>
      <div className="titlebar-controls">
        <IconButton label={t('app.back')} disabled={!canBack} onClick={back}>
          <ArrowLeft aria-hidden="true" />
        </IconButton>
        <IconButton label={t('app.forward')} disabled={!canForward} onClick={forward}>
          <ArrowRight aria-hidden="true" />
        </IconButton>
        <IconButton
          label={t(collapsed ? 'sidebar.expandList' : 'sidebar.collapseList')}
          aria-controls={canToggle ? 'sidebar-list' : undefined}
          aria-expanded={canToggle ? !collapsed : undefined}
          disabled={!canToggle}
          onClick={toggle}
        >
          {collapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
        </IconButton>
      </div>
    </nav>
  );
}
