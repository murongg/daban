import { Plug } from 'lucide-react';
import { type Dispatch, useState } from 'react';
import type { Action, Bot, State } from '../../app/state';
import { Dialog } from '../../components/controls/Dialog';
import { t, useLocale } from '../../i18n/locale';
import { Integrations } from '../integrations/Integrations';
import { Skills } from '../skills/Skills';
import './capabilities.css';

export function Capabilities({
  state,
  bot,
  dispatch,
  notify,
}: {
  state: State;
  bot: Bot;
  dispatch: Dispatch<Action>;
  notify: (message: string) => unknown;
}) {
  useLocale();
  const [connectionBot, setConnectionBot] = useState<Bot>();
  const [dirty, setDirty] = useState(false);
  return (
    <>
      <div className="capabilities-heading">
        <div>
          <strong>{t('capabilities.title')}</strong>
          <p>{t('capabilities.privateHint', { 0: bot.name })}</p>
        </div>
        <button type="button" className="secondary" onClick={() => setConnectionBot(bot)}>
          <Plug size={16} />
          {t('common.externalTools')}
        </button>
      </div>
      <Skills state={state} bot={bot} dispatch={dispatch} notify={notify} />
      {connectionBot && (
        <Dialog
          title={t('capabilities.mcpForBot', { 0: connectionBot.name })}
          // Dismissal can be refused while a draft is dirty. Keep the controls available for editing.
          motion={!dirty}
          onClose={() => {
            if (dirty) {
              notify(t('capabilities.finishEditing'));
              return;
            }
            setConnectionBot(undefined);
          }}
        >
          <Integrations bots={state.bots} bot={connectionBot} onDirty={setDirty} />
        </Dialog>
      )}
    </>
  );
}
