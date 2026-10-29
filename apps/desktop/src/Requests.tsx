import { agentId, type Interaction, matchesReply, type UserReply } from '@daban/protocol';
import { Check, Inbox, X } from 'lucide-react';
import { type Dispatch, useEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { runtimeError, useRuntime } from './Runtime';
import type { Action, State } from './state';

function draftAnswer(drafts: State['replyDrafts'][string], id: string) {
  // Model-provided question IDs must never read inherited object properties as saved answers.
  return Object.hasOwn(drafts, id) ? drafts[id] : { selected: [], custom: '' };
}

function Request({
  request,
  state,
  dispatch,
  notify,
}: {
  request: Interaction;
  state: State;
  dispatch: Dispatch<Action>;
  notify: (message: string) => unknown;
}) {
  const runtime = useRuntime();
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(''),
    [submitted, setSubmitted] = useState<UserReply>(),
    [receipt, setReceipt] = useState<Interaction>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = request.status === 'pending' && receipt ? receipt : request;
  const bot = state.bots.find((bot) => !bot.members && agentId(bot.id) === current.bot);
  const draft = state.replyDrafts[current.id] || {};
  const answer: UserReply = {
    kind: 'answer',
    answers:
      current.kind === 'question'
        ? current.questions.map((question) => ({
            id: question.id,
            selected: draftAnswer(draft, question.id).selected,
            custom: draftAnswer(draft, question.id).custom,
          }))
        : [],
  };
  const frozen = saving || !!submitted;
  const savedAnswers = current.reply?.kind === 'answer' ? current.reply.answers : [];
  async function submit(reply: UserReply) {
    if (saving) return;
    const payload = submitted || reply;
    setSubmitted(payload);
    setSaving(true);
    setError('');
    try {
      const saved = await runtime.command<Interaction>({
        type: 'interaction.reply',
        bot: current.bot,
        runId: current.runId,
        id: current.id,
        reply: payload,
      });
      if (mounted.current) {
        setReceipt(saved);
        setSubmitted(undefined);
        notify('回复已提交。');
      }
    } catch (error) {
      if (mounted.current) {
        setError(runtimeError(error));
        if (
          error instanceof Error &&
          [
            'INVALID_INTERACTION_REPLY',
            'INTERACTION_CLOSED',
            'INTERACTION_CONFLICT',
            'INTERACTION_NOT_FOUND',
          ].includes(error.message)
        )
          setSubmitted(undefined);
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <article className="approval user-request">
      <div className="approval-author">
        {bot && <Avatar bot={bot} size="small" />}
        <span>{bot?.name || 'Bot'}</span>
        {current.conversationId && (
          <span>{state.bots.find((bot) => bot.id === current.conversationId)?.name || '群聊'}</span>
        )}
        <span className="spacer" />
        <span>{current.kind === 'question' ? '需要你的回答' : '单次权限确认'}</span>
      </div>
      <h3 className="approval-title">
        {current.kind === 'question'
          ? '补充信息后继续'
          : current.tool === 'mcp_call'
            ? '允许调用这个外部工具吗？'
            : '允许读取这个链接吗？'}
      </h3>
      {current.kind === 'approval' && current.tool === 'web_fetch' && (
        <>
          <p className="approval-description">
            仅允许这一次公开网页读取；不会授予登录状态或其他网址的权限。
          </p>
          <p className="request-value">{current.url}</p>
        </>
      )}
      {current.kind === 'approval' && current.tool === 'mcp_call' && (
        <>
          <p className="approval-description">
            将下列参数发送至这个连接，可能执行外部操作。仅允许本次调用，不会授予其他工具或后续调用的权限。
          </p>
          <p className="request-value">
            {current.name} · {current.operation}
          </p>
          <p className="request-value">{current.origin}</p>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Long tool arguments need a keyboard-focusable scrolling surface. */}
          <section className="request-arguments" aria-label="本次工具调用参数" tabIndex={0}>
            <pre className="request-value">{current.arguments}</pre>
          </section>
        </>
      )}
      {current.status === 'pending' ? (
        <>
          {current.kind === 'question' && (
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                await submit(answer);
              }}
            >
              {current.questions.map((question) => {
                const value = draftAnswer(draft, question.id);
                return (
                  <fieldset key={question.id} className="request-question" disabled={frozen}>
                    <legend>{question.question}</legend>
                    {question.detail && <p className="request-value">{question.detail}</p>}
                    {question.options?.map((option) => (
                      <label className="request-option" key={option.label}>
                        <input
                          type={question.multiSelect ? 'checkbox' : 'radio'}
                          name={`${current.id}-${question.id}`}
                          checked={value.selected?.includes(option.label) || false}
                          onChange={(event) =>
                            dispatch({
                              type: 'reply-draft',
                              id: current.id,
                              question: question.id,
                              selected: question.multiSelect
                                ? event.target.checked
                                  ? [...value.selected, option.label]
                                  : value.selected.filter((label) => label !== option.label)
                                : [option.label],
                            })
                          }
                        />
                        <span>
                          {option.label}
                          {option.description && (
                            <span className="field-help">{option.description}</span>
                          )}
                        </span>
                      </label>
                    ))}
                    <label className="field-label">
                      {question.options?.length ? '补充回答' : '你的回答'}
                      <textarea
                        className="field"
                        rows={2}
                        maxLength={4000}
                        value={value.custom || ''}
                        onChange={(event) =>
                          dispatch({
                            type: 'reply-draft',
                            id: current.id,
                            question: question.id,
                            custom: event.target.value,
                          })
                        }
                      />
                    </label>
                  </fieldset>
                );
              })}
              <div className="approval-actions">
                <button
                  type="submit"
                  className="primary"
                  disabled={saving || !matchesReply(current, submitted || answer)}
                >
                  {saving ? '正在提交…' : submitted ? '重试提交' : '提交回复'}
                </button>
              </div>
            </form>
          )}
          {current.kind === 'approval' && (
            <div className="approval-actions">
              {submitted ? (
                <button
                  type="button"
                  className="primary"
                  disabled={saving}
                  onClick={() => submit(submitted)}
                >
                  {saving ? '正在提交…' : '重试提交'}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="primary"
                    disabled={saving}
                    onClick={() => submit({ kind: 'decision', allow: true })}
                  >
                    仅允许这一次
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={saving}
                    onClick={() => submit({ kind: 'decision', allow: false })}
                  >
                    拒绝
                  </button>
                </>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="request-result">
          {current.status === 'resolved' ? (
            current.reply?.kind === 'answer' ? (
              <span className="approval-state">
                <Check />
                已回复
              </span>
            ) : (
              <span className="approval-state">
                {current.reply?.kind === 'decision' && current.reply.allow ? (
                  <>
                    <Check />
                    已允许这一次
                  </>
                ) : (
                  <>
                    <X />
                    已拒绝
                  </>
                )}
              </span>
            )
          ) : (
            <span className="approval-state">
              <X />
              {current.status === 'interrupted' ? '任务已中断，这个请求不能再回复' : '请求已撤销'}
            </span>
          )}
          {current.kind === 'question' && (
            <dl className="request-answers">
              {current.questions.map((question) => {
                const answer = savedAnswers.find((item) => item.id === question.id);
                return (
                  <div key={question.id}>
                    <dt>{question.question}</dt>
                    {question.detail && (
                      <dd className="field-help request-value">{question.detail}</dd>
                    )}
                    {answer && (
                      <dd className="request-value">
                        {[...answer.selected, answer.custom].filter(Boolean).join('；')}
                      </dd>
                    )}
                  </div>
                );
              })}
            </dl>
          )}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
          {submitted && ' 请核对连接后重试；会提交同一份回复。'}
        </p>
      )}
    </article>
  );
}
export function Requests({
  state,
  dispatch,
  notify,
  bot,
  runs,
  focus,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  notify: (message: string) => unknown;
  bot?: string;
  runs?: readonly string[];
  focus?: string;
}) {
  const runtime = useRuntime();
  const [filter, setFilter] = useState<'pending' | 'done'>('pending');
  const requests = runtime.snapshot.interactions || [];
  const pending = requests.filter((item) => item.status === 'pending');
  const entries = focus
    ? requests.filter((item) => item.id === focus)
    : runs
      ? requests.filter((item) => runs.includes(item.runId))
      : bot
        ? requests.filter(
            (item) =>
              !item.conversationId &&
              item.bot === agentId(bot) &&
              (item.status === 'pending' ||
                item.runId === runtime.snapshot.agents[agentId(bot)]?.runId),
          )
        : requests.filter((item) =>
            filter === 'pending' ? item.status === 'pending' : item.status !== 'pending',
          );
  const content = (
    <>
      {!bot && !runs && !focus && (
        <div className="filter-tabs" role="tablist" aria-label="收件箱筛选">
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'pending'}
            onClick={() => setFilter('pending')}
          >
            待处理 {pending.length ? `· ${pending.length}` : ''}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'done'}
            onClick={() => setFilter('done')}
          >
            已处理
          </button>
        </div>
      )}
      {entries.map((item) => (
        <Request key={item.id} request={item} state={state} dispatch={dispatch} notify={notify} />
      ))}
      {!bot && !runs && !entries.length && (
        <div className="empty-panel">
          <Inbox />
          <h3>{filter === 'pending' ? '暂时没有需要确认的事' : '还没有处理记录'}</h3>
          <p>真实任务需要你的回答或确认时，会集中显示在这里。</p>
        </div>
      )}
    </>
  );
  return bot || runs ? (
    <div className="request-list">{content}</div>
  ) : (
    <section className="full-page" aria-label="收件箱">
      <div className="page-inner">
        <h2 className="page-heading">需要你看一眼</h2>
        <p className="page-subtitle">回答问题或确认这一次操作，让 Bot 继续。</p>
        {content}
      </div>
    </section>
  );
}
