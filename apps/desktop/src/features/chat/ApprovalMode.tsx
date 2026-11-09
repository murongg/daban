import { isApprovalMode, type ApprovalMode as Mode } from '@daban/protocol';
import { Hand, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Select } from '../../components/controls/Select';
import { t, useLocale } from '../../i18n/locale';
import './approval.css';

export function ApprovalMode({
  value,
  onChange,
  disabled = false,
  browserApproval = false,
  browserGranted = false,
}: {
  value: Mode;
  onChange: (mode: Mode) => unknown;
  disabled?: boolean;
  browserApproval?: boolean;
  browserGranted?: boolean;
}) {
  useLocale();
  const previousFull = value === 'full' && browserApproval && !browserGranted;
  return (
    <Select
      label={t('approval.mode')}
      className="approval-choice"
      value={previousFull ? 'previous-full' : value}
      disabled={disabled}
      onValueChange={(mode) => {
        if (isApprovalMode(mode)) onChange(mode);
      }}
      options={[
        {
          value: 'ask',
          label: t('approval.ask'),
          icon: <Hand className="approval-icon" />,
          detail: <span className="approval-mode-detail">{t('approval.askDescription')}</span>,
        },
        {
          value: 'auto',
          label: t('approval.auto'),
          icon: <ShieldCheck className="approval-icon" />,
          detail: <span className="approval-mode-detail">{t('approval.autoDescription')}</span>,
        },
        {
          value: 'full',
          label: t('approval.full'),
          icon: <ShieldAlert className="approval-icon" />,
          detail: (
            <span className="approval-mode-detail">
              {t(browserApproval ? 'approval.fullBrowserDescription' : 'approval.fullDescription')}
            </span>
          ),
        },
        ...(previousFull
          ? [
              {
                value: 'previous-full',
                label: t('approval.previousFull'),
                icon: <ShieldAlert className="approval-icon" />,
                detail: (
                  <span className="approval-mode-detail">{t('approval.fullDescription')}</span>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}
