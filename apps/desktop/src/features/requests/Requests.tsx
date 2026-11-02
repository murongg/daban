import { agentId, type Interaction, matchesReply, type UserReply } from '@daban/protocol';
import { Braces, Check, ChevronDown, Inbox, X } from 'lucide-react';
import { type Dispatch, useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Action, State } from '../../app/state';
import { Tooltip } from '../../components/controls/Tooltip';
import { t, useLocale } from '../../i18n/locale';
import { Avatar } from '../bots/Avatar';
import { Command } from './Command';
import { Software, SoftwareStatus } from './Software';

function draftAnswer(drafts: State['replyDrafts'][string], id: string) {
  // Model-provided question IDs must never read inherited object properties as saved answers.
  return Object.hasOwn(drafts, id) ? drafts[id] : { selected: [], custom: '' };
}

function Approval({ request }: { request: Extract<Interaction, { kind: 'approval' }> }) {
  return (
    <>
      {request.tool === 'vm_command' && <Command request={request} />}
      {request.tool === 'web_fetch' && (
        <>
          <p className="approval-description">{t('requests.allowOnlyPublicWebpageReadDoesNot')}</p>
          <p className="request-value">{request.url}</p>
        </>
      )}
      {request.tool === 'software_install' && <Software request={request} />}
      {request.tool === 'mcp_call' && (
        <>
          <p className="approval-description">
            {t('requests.sendParametersConnectionWhichMayPerformExternal')}
          </p>
          <p className="request-value">
            {request.name} · {request.operation}
          </p>
          <p className="request-value">{request.origin}</p>
          <details className="request-details" open={request.status !== 'pending'}>
            <Tooltip label={t('requests.viewArguments')}>
              <summary className="request-toggle" aria-label={t('requests.viewArguments')}>
                <Braces aria-hidden="true" />
                <ChevronDown className="request-chevron" aria-hidden="true" />
              </summary>
            </Tooltip>
            <section
              className="request-arguments"
              aria-label={t('requests.toolCallParameters')}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Long tool arguments need a keyboard-focusable scrolling surface.
              tabIndex={0}
            >
              <pre className="request-value">{request.arguments}</pre>
            </section>
          </details>
        </>
      )}
    </>
  );
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
  useLocale();
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
  const settled = current.kind === 'approval' && current.status !== 'pending';
  const subject =
    current.kind === 'approval'
      ? current.tool === 'vm_command' || current.tool === 'software_install'
        ? current.purpose
        : current.tool === 'mcp_call'
          ? `${current.name} · ${current.operation}`
          : current.url
      : '';

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
        notify(t('requests.replySubmitted'));
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
    <article className={`approval user-request${settled ? ' is-settled' : ''}`}>
      <div className="approval-author">
        {bot && <Avatar bot={bot} size="small" />}
        <span>{bot?.name || 'Bot'}</span>
        {current.conversationId && (
          <span>
            {state.bots.find((bot) => bot.id === current.conversationId)?.name ||
              t('common.groupChat')}
          </span>
        )}
        <span className="spacer" />
        {!settled && (
          <span>
            {current.kind === 'question'
              ? t('requests.needsAnswer')
              : t('requests.oneTimePermission')}
          </span>
        )}
      </div>
      {!settled && (
        <h3 className="approval-title">
          {current.kind === 'question'
            ? t('requests.addDetailsContinue')
            : current.tool === 'vm_command'
              ? t('requests.allowCommandLinuxVirtualMachine')
              : current.tool === 'software_install'
                ? t('requests.allowInstallationSoftware')
                : current.tool === 'mcp_call'
                  ? t('requests.allowExternalToolCall')
                  : t('requests.allowReadingUrl')}
        </h3>
      )}
      {current.kind === 'approval' &&
        (settled ? (
          <details className="request-details request-record">
            <Tooltip label={t('requests.viewOperationDetails')}>
              <summary aria-label={`${subject} · ${t('requests.viewOperationDetails')}`}>
                <ChevronDown className="request-chevron" aria-hidden="true" />
                <span className="request-subject">{subject}</span>
              </summary>
            </Tooltip>
            <Approval request={current} />
          </details>
        ) : (
          <Approval request={current} />
        ))}
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
                      {question.options?.length
                        ? t('requests.additionalAnswer')
                        : t('requests.answer')}
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
                  {saving
                    ? t('common.submitting')
                    : submitted
                      ? t('requests.retrySubmission')
                      : t('requests.submitReply')}
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
                  {saving ? t('common.submitting') : t('requests.retrySubmission')}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="primary"
                    disabled={saving}
                    onClick={() => submit({ kind: 'decision', allow: true })}
                  >
                    {current.tool === 'vm_command'
                      ? t('requests.confirmExecution')
                      : current.tool === 'software_install'
                        ? t('requests.confirmInstallation')
                        : t('requests.allowOnce')}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={saving}
                    onClick={() => submit({ kind: 'decision', allow: false })}
                  >
                    {t('requests.decline')}
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
                {t('requests.answered')}
              </span>
            ) : (
              <span className="approval-state">
                {current.reply?.kind === 'decision' && current.reply.allow ? (
                  <>
                    <Check />
                    {current.kind === 'approval' && current.tool === 'vm_command'
                      ? t('requests.vmCommandApproved')
                      : current.kind === 'approval' && current.tool === 'software_install'
                        ? t('requests.installationApproved')
                        : t('requests.allowedOnce')}
                  </>
                ) : (
                  <>
                    <X />
                    {t('common.declined')}
                  </>
                )}
              </span>
            )
          ) : (
            <span className="approval-state">
              <X />
              {current.status === 'interrupted'
                ? t('requests.taskInterruptedRequestCanNoLongerAnswered')
                : t('requests.requestWithdrawn')}
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
      {current.kind === 'approval' && current.tool === 'software_install' && (
        <SoftwareStatus request={current} />
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
          {submitted && t('requests.checkConnectionRetrySameReplyWillSubmitted')}
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
  useLocale();
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
        <div className="filter-tabs" role="tablist" aria-label={t('common.inboxFilter')}>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'pending'}
            onClick={() => setFilter('pending')}
          >
            {t('common.do')}
            {pending.length ? `· ${pending.length}` : ''}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'done'}
            onClick={() => setFilter('done')}
          >
            {t('common.handled')}
          </button>
        </div>
      )}
      {entries.map((item) => (
        <Request key={item.id} request={item} state={state} dispatch={dispatch} notify={notify} />
      ))}
      {!bot && !runs && !entries.length && (
        <div className="empty-panel">
          <Inbox />
          <h3>
            {filter === 'pending'
              ? t('common.nothingNeedsAttentionRightNow')
              : t('common.noHandledRequestsYet')}
          </h3>
          <p>{t('requests.questionsApprovalsNeededRealTasksAppearHere')}</p>
        </div>
      )}
    </>
  );
  return bot || runs ? (
    <div className="request-list">{content}</div>
  ) : (
    <section className="full-page" aria-label={t('common.inbox')}>
      <div className="page-inner">
        <h2 className="page-heading">{t('common.needsAttention')}</h2>
        <p className="page-subtitle">{t('requests.answerQuestionApproveOneOperationLetBot')}</p>
        {content}
      </div>
    </section>
  );
}
