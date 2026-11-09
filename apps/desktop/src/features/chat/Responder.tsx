import { agentId } from '@daban/protocol';
import type { Dispatch } from 'react';
import type { Action, Bot } from '../../app/state';
import { Select } from '../../components/controls/Select';
import { t } from '../../i18n/locale';
import { Avatar } from '../bots/Avatar';

export function Responder({
  chat,
  bots,
  assistant,
  locked,
  disabled,
  dispatch,
}: {
  chat: Bot;
  bots: readonly Bot[];
  assistant?: Bot;
  locked: boolean;
  disabled: boolean;
  dispatch: Dispatch<Action>;
}) {
  const general = t('conversations.generalAssistant');
  const name =
    assistant?.name ?? (chat.assistant ? t('conversations.assistantUnavailable') : general);
  if (locked)
    return (
      <span className="chat-responder-label" title={name}>
        {assistant && <Avatar bot={assistant} size="small" />}
        <span>{name}</span>
      </span>
    );
  const options = [
    { value: '', label: general },
    ...bots
      .filter((bot) => !bot.kind && !bot.members && (!bot.archived || bot === assistant))
      .map((bot) => ({
        value: agentId(bot.id),
        label: bot.name,
        icon: <Avatar bot={bot} size="small" />,
        disabled: bot.archived,
      })),
    ...(chat.assistant && !assistant
      ? [{ value: chat.assistant, label: name, disabled: true }]
      : []),
  ];
  return (
    <Select
      className="chat-responder"
      label={t('conversations.responder')}
      value={chat.assistant ?? ''}
      options={options}
      disabled={disabled}
      onValueChange={(value) =>
        dispatch({ type: 'chat-assistant', bot: chat.id, assistant: value || undefined })
      }
    />
  );
}
