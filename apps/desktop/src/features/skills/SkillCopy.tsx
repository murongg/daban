import { agentId, type SkillEntry } from '@daban/protocol';
import { useEffect, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Bot } from '../../app/state';
import { Dialog } from '../../components/controls/Dialog';
import { Select } from '../../components/controls/Select';
import { t, useLocale } from '../../i18n/locale';

export function SkillCopy({
  bot,
  bots,
  entry,
  onClose,
  onCopied,
}: {
  bot: Bot;
  bots: Bot[];
  entry: SkillEntry;
  onClose: () => unknown;
  onCopied: () => unknown;
}) {
  useLocale();
  const runtime = useRuntime();
  const choices = bots.filter(
    (item) =>
      !item.members &&
      !item.archived &&
      (!entry.ownerBot || item.id !== bot.id) &&
      runtime.snapshot.profiles.some(
        (profile) => profile.id === agentId(item.id) && !profile.archived,
      ),
  );
  const [target, setTarget] = useState(
    choices.find((item) => item.id !== bot.id)?.id ?? choices[0]?.id ?? '',
  );
  const first = choices.find((item) => item.id !== bot.id)?.id ?? choices[0]?.id;
  useEffect(() => {
    if (!target && first) setTarget(first);
  }, [target, first]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function copy() {
    if (!target || busy) return;
    setBusy(true);
    setError('');
    try {
      await runtime.command({
        type: 'skill.copy',
        bot: agentId(bot.id),
        id: entry.id,
        revision: entry.revision,
        targetBot: agentId(target),
      });
      onCopied();
    } catch (cause) {
      setError(runtimeError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={t('capabilities.copySkill')}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="dialog-description">{t('capabilities.copyHint', { 0: entry.name })}</p>
      <div className="field-label">
        {t('capabilities.chooseBot')}
        <Select
          label={t('capabilities.chooseBot')}
          value={target}
          disabled={busy}
          onValueChange={setTarget}
          options={choices.map((item) => ({ value: item.id, label: item.name }))}
        />
      </div>
      {!choices.length && <p className="inline-note">{t('capabilities.createBotFirst')}</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !choices.some((item) => item.id === target)}
          onClick={() => copy().catch((cause) => setError(runtimeError(cause)))}
        >
          {busy ? t('common.saving') : t('capabilities.addAndEnable')}
        </button>
      </div>
    </Dialog>
  );
}
