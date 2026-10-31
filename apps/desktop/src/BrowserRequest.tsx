import type { BrowserBinding, BrowserPrompt, BrowserState } from '@daban/protocol';
import { useState } from 'react';
import { type BrowserAnswer, browserFiles } from './browsing';
import { FilePicker } from './FilePicker';
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
  const [text, setText] = useState(prompt.kind === 'dialog' ? prompt.defaultValue : ''),
    [files, setFiles] = useState<File[]>([]),
    [error, setError] = useState(''),
    [reading, setReading] = useState(false);
  return (
    <form
      className="browser-request"
      aria-label={prompt.kind === 'dialog' ? '网页请求' : '网页选文件请求'}
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
      <h3>{prompt.kind === 'dialog' ? '网页等待你确认' : '网页需要选择文件'}</h3>
      <p className="browser-request-source">
        <span>请求所在标签：{tab.title || '新标签页'}</span>
        <span>{tab.url}</span>
      </p>
      {show && (
        <button type="button" className="text-button" disabled={disabled || reading} onClick={show}>
          显示请求所在标签
        </button>
      )}
      {prompt.kind === 'dialog' ? (
        <>
          <p className="browser-request-message">{prompt.message || '网页未提供说明。'}</p>
          {prompt.truncated && (
            <p className="form-error" role="alert">
              说明过长，当前显示不完整，已禁止确认。请取消后联系网站处理。
            </p>
          )}
          {prompt.dialog === 'prompt' && (
            <label className="field-label">
              网页回复
              <input
                className="field"
                aria-label="网页回复"
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
          <p>选择要交给此网页的本机文件，最多 {prompt.multiple ? '4 份' : '1 份'}，合计 5 MB。</p>
          <div className="field-label">
            选择本机文件
            <FilePicker
              aria-label="选择发送给网页的文件"
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
          ? '接管电脑后可以处理。'
          : '回复和文件仅交给上方标签内的这个网页请求，不会保存到聊天草稿。'}
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
          {prompt.kind === 'dialog' ? '取消网页请求' : '取消选文件'}
        </button>
        <button
          type="submit"
          className="primary"
          disabled={
            disabled || reading || (prompt.kind === 'dialog' ? prompt.truncated : !files.length)
          }
        >
          {reading ? '正在处理…' : prompt.kind === 'dialog' ? '确认网页请求' : '发送文件到网页'}
        </button>
      </div>
    </form>
  );
}
