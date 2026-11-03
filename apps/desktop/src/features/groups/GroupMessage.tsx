import type { GroupMessage as SavedMessage } from '@daban/protocol';
import { FileText, Paperclip } from 'lucide-react';
import { memo } from 'react';
import { resolveMentions } from '../../../shared/mentions';
import { runtimeMessage as taskError } from '../../app/Runtime';
import type { Bot, WorkspaceFile } from '../../app/state';
import { Markdown } from '../../components/content/Markdown';
import { t, useLocale } from '../../i18n/locale';
import { taskPhase } from '../../i18n/tasks';
import { Avatar } from '../bots/Avatar';
import { Execution } from '../chat/Execution';
import { MentionText } from './Mentions';

export const GroupMessage = memo(function GroupMessage({
  value,
  author,
  roster,
  group,
  preview,
  openLink,
  copyText,
  notify,
  inputFile,
}: {
  value: SavedMessage;
  author?: Bot;
  roster: { id: string; name: string }[];
  group: string;
  preview: (file: WorkspaceFile) => unknown;
  openLink: (url: string) => unknown;
  copyText: (text: string) => unknown;
  notify: (text: string) => unknown;
  inputFile: (message: SavedMessage, name: string) => unknown;
}) {
  useLocale();
  const files: WorkspaceFile[] = (value.files || []).map((file) => ({
    id: `runtime:${file.path}`,
    name: file.name,
    kind: file.name.split('.').at(-1)?.toUpperCase() || t('common.files'),
    size: `${(file.size / 1024).toFixed(1)} KB`,
    modified: file.modified,
    runtimePath: file.path,
    content: '',
  }));
  return (
    <article className={`message ${value.role}`} key={value.id}>
      {value.role === 'bot' && (
        <div className="message-author">
          {author && <Avatar bot={author} />}
          {value.name || author?.name || 'Bot'}
        </div>
      )}
      {value.role === 'bot' && value.runId && value.author && (
        <Execution
          scope={{ bot: value.author, runId: value.runId, conversationId: group }}
          phase={value.phase}
        />
      )}
      <div className="bubble">
        {value.role === 'bot' ? (
          <Markdown
            text={value.text}
            streaming={!!value.phase && value.phase !== 'completed'}
            fileIds={files.map((file) => file.id)}
            files={files}
            preview={preview}
            openLink={openLink}
            copyText={copyText}
            notify={notify}
          />
        ) : value.role === 'notice' ? (
          taskError(value.text)
        ) : (
          <MentionText
            text={value.text}
            mentions={resolveMentions(value.text, roster, []).mentions}
          />
        )}
      </div>
      {value.phase && value.phase !== 'completed' && (
        <p className="inline-note">{t('groupchat.taskStatus', { 0: taskPhase(value.phase) })}</p>
      )}
      {files.map((file) => (
        <button
          type="button"
          className="message-artifact"
          key={file.id}
          onClick={() => preview(file)}
        >
          <FileText />
          {file.name}
        </button>
      ))}
      {files.length >= 20 && (
        <p className="inline-note">{t('groupchat.eachMessageShowsUpFilesViewAll')}</p>
      )}
      {value.inputNames?.map((name) => (
        <button
          type="button"
          className="message-artifact"
          key={name}
          onClick={() => inputFile(value, name)}
        >
          <Paperclip />
          {name}
        </button>
      ))}
    </article>
  );
});
