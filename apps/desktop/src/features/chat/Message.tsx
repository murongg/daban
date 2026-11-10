import type { ReplyStream, TaskPhase } from '@daban/protocol';
import { Check, ChevronDown, ExternalLink, FileText, Info, Monitor } from 'lucide-react';
import { type Dispatch, memo } from 'react';
import { runtimeMessage as taskError } from '../../app/Runtime';
import type { Action, Bot, WorkspaceFile } from '../../app/state';
import { Markdown } from '../../components/content/Markdown';
import { t, useLocale } from '../../i18n/locale';
import { Avatar } from '../bots/Avatar';
import { Execution } from './Execution';
import type { DisplayMessage } from './response';

export const Message = memo(function Message({
  message,
  author,
  showAuthor,
  files,
  target,
  revision,
  recordedRun,
  recordedPhase,
  recordedElapsed,
  recordedThinking,
  dispatch,
  preview,
  openLink,
  copyText,
  notify,
}: {
  message: DisplayMessage;
  author: Bot;
  showAuthor: boolean;
  files: WorkspaceFile[];
  target: string;
  revision: number;
  recordedRun?: string;
  recordedPhase?: TaskPhase;
  recordedElapsed?: number;
  recordedThinking?: ReplyStream['thinking'];
  dispatch: Dispatch<Action>;
  preview: (file: WorkspaceFile) => unknown;
  openLink: (url: string) => unknown;
  copyText: (text: string) => unknown;
  notify: (text: string) => unknown;
}) {
  useLocale();
  function artifact(id: string) {
    const file = files.find((item) => item.id === id);
    if (!file) return null;
    return (
      <button type="button" className="message-artifact" key={id} onClick={() => preview(file)}>
        <span className="file-symbol">
          <FileText />
        </span>
        <div>
          <div className="artifact-name">{file.name}</div>
          <div className="artifact-meta">
            {file.kind} · {file.size}
          </div>
        </div>
        <ExternalLink />
      </button>
    );
  }
  if (message.role === 'activity')
    return (
      <details className="activity">
        <summary>
          <Check />
          {message.text}
          <ChevronDown className="activity-chevron" />
        </summary>
        <div className="activity-files">
          {message.files?.map((id) => {
            const file = files.find((item) => item.id === id);
            return (
              file && (
                <button
                  type="button"
                  className="activity-file"
                  key={id}
                  onClick={() => preview(file)}
                >
                  <FileText />
                  {file.name}
                </button>
              )
            );
          })}
        </div>
      </details>
    );
  if (message.role === 'notice')
    return (
      <div className="message">
        <p className="demo-message">
          <Info />
          <span>{message.text}</span>
        </p>
      </div>
    );
  const completed = recordedPhase === 'completed';
  const execution = recordedRun && (
    <Execution
      scope={{ bot: target, runId: recordedRun, chatRevision: revision }}
      phase={recordedPhase}
      elapsedMs={recordedElapsed}
      thinking={recordedThinking}
      messageDetails={completed}
    />
  );
  return (
    <article
      className={`message ${message.role}`}
      aria-live={message.streaming ? 'off' : undefined}
    >
      {showAuthor && message.role === 'bot' && (
        <div className="message-author">
          <Avatar bot={author} />
          {author.name}
        </div>
      )}
      {!completed && execution}
      <div
        className="bubble"
        data-chat-excerpt={!message.streaming && !message.error ? '' : undefined}
      >
        {message.role === 'bot' ? (
          <Markdown
            text={message.error ? taskError(message.error) : message.text}
            streaming={!!message.streaming || !!message.incomplete}
            fileIds={message.files || message.references}
            files={files}
            preview={preview}
            openLink={openLink}
            notify={notify}
            copyText={copyText}
          />
        ) : (
          message.text
        )}
      </div>
      {completed && execution}
      {message.incomplete && (
        <p className="inline-note reply-state">{t('chat.responseIncomplete')}</p>
      )}
      {message.files?.map(artifact)}
      {message.files?.includes('weekly-summary') && (
        <div className="artifact-note">
          <Check />
          {t('chat.draftReadyReview')}
        </div>
      )}
      {message.handoff && (
        <button
          type="button"
          className="secondary"
          style={{ marginTop: 12 }}
          onClick={() => dispatch({ type: 'panel', panel: 'computer' })}
        >
          <Monitor />
          {t('chat.viewComputer')}
        </button>
      )}
    </article>
  );
});
