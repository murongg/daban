import type { BrowserBinding, BrowserPrompt, BrowserState } from '@daban/protocol';
import { useState } from 'react';
import { type BrowserAnswer, browserFiles } from './browsing';
import { FilePicker } from './FilePicker';
import { t, useLocale } from './locale';
import { runtimeError } from './Runtime';

export function BrowserRequest({
  prompt,
  tab,
  show,
  binding,
  disabled,
  send,
}: {
  prompt: BrowserPrompt;
  tab: BrowserState['tabs'][number];
  show?: () => Promise<unknown>;
  binding: BrowserBinding;
  disabled: boolean;
  send: (answer: BrowserAnswer) => Promise<unknown>;
}) {
  useLocale();
  const [text, setText] = useState(prompt.kind === 'dialog' ? prompt.defaultValue : ''),
    [files, setFiles] = useState<File[]>([]),
    [error, setError] = useState(''),
    [reading, setReading] = useState(false);
  return (
    <form
      className="browser-request"
      aria-label={
        prompt.kind === 'dialog'
          ? t('browserrequest.webpageRequest')
          : t('browserrequest.webpageFileSelectionRequest')
      }
      onSubmit={async (event) => {
        event.preventDefault();
        if (disabled || reading) return;
        setReading(true);
        setError('');
        try {
          if (prompt.kind === 'dialog')
            await send({
              kind: 'dialog',
              binding,
              prompt: prompt.id,
              accept: true,
              ...(prompt.dialog === 'prompt' ? { text } : {}),
            });
          else
            await send({
              kind: 'files',
              binding,
              prompt: prompt.id,
              files: await browserFiles(files),
            });
        } catch (error) {
          setError(runtimeError(error));
        } finally {
          setReading(false);
        }
      }}
    >
      <h3>
        {prompt.kind === 'dialog'
          ? t('browserrequest.webpageAwaitingConfirmation')
          : t('browserrequest.webpageNeedsFile')}
      </h3>
      <p className="browser-request-source">
        <span>
          {t('browserrequest.requestingTab')}
          {tab.title || t('common.newTab')}
        </span>
        <span>{tab.url}</span>
      </p>
      {show && (
        <button type="button" className="text-button" disabled={disabled || reading} onClick={show}>
          {t('browserrequest.showRequestingTab')}
        </button>
      )}
      {prompt.kind === 'dialog' ? (
        <>
          <p className="browser-request-message">
            {prompt.message || t('browserrequest.webpageProvidedNoDescription')}
          </p>
          {prompt.truncated && (
            <p className="form-error" role="alert">
              {t('browserrequest.descriptionTooLongIncompleteSoConfirmationBlocked')}
            </p>
          )}
          {prompt.dialog === 'prompt' && (
            <label className="field-label">
              {t('browserrequest.webpageReply')}
              <input
                className="field"
                aria-label={t('browserrequest.webpageReply')}
                autoComplete="off"
                maxLength={2000}
                value={text}
                disabled={disabled || reading}
                onChange={(event) => setText(event.target.value)}
              />
            </label>
          )}
        </>
      ) : (
        <>
          <p>
            {t('browserrequest.chooseLocalFilesWebpageUp')}
            {prompt.multiple ? t('browserrequest.copies') : t('browserrequest.copy')}
            {t('browserrequest.mbCombined')}
          </p>
          <div className="field-label">
            {t('browserrequest.chooseLocalFile')}
            <FilePicker
              aria-label={t('browserrequest.chooseFilesSendWebpage')}
              multiple={prompt.multiple}
              disabled={disabled || reading}
              onChange={(event) => {
                setFiles(Array.from(event.target.files || []));
                setError('');
              }}
            />
          </div>
          {files.length > 0 && <p>{files.map((file) => file.name).join('、')}</p>}
        </>
      )}
      <p className="inline-note">
        {disabled
          ? t('browserrequest.takeOverComputerContinue')
          : t('browserrequest.replyFilesGoOnlyWebpageRequestShown')}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="browser-request-actions">
        <button
          type="button"
          className="secondary"
          disabled={disabled || reading}
          onClick={async () => {
            await send(
              prompt.kind === 'dialog'
                ? { kind: 'dialog', binding, prompt: prompt.id, accept: false }
                : { kind: 'files', binding, prompt: prompt.id, files: [] },
            );
          }}
        >
          {prompt.kind === 'dialog'
            ? t('browserrequest.cancelWebpageRequest')
            : t('browserrequest.cancelFileSelection')}
        </button>
        <button
          type="submit"
          className="primary"
          disabled={
            disabled || reading || (prompt.kind === 'dialog' ? prompt.truncated : !files.length)
          }
        >
          {reading
            ? t('common.processing')
            : prompt.kind === 'dialog'
              ? t('browserrequest.confirmWebpageRequest')
              : t('browserrequest.sendFilesWebpage')}
        </button>
      </div>
    </form>
  );
}
