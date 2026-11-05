import {
  type DeliveryAttempt,
  type DeliveryCriterion,
  type DeliveryFileEvidence,
  type DeliveryPhase,
  isRuntimeDownload,
  type WorkItem,
} from '@daban/protocol';
import { ChevronDown, ChevronUp, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import type { MessageKey } from '../../../shared/locale';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { t, useLocale } from '../../i18n/locale';
import { downloadBlob } from '../files/files';
import { useDelivery } from './delivery-controller';
import './delivery.css';

const phaseMessages: Record<DeliveryPhase, MessageKey> = {
  accepted: 'delivery.phase.accepted',
  running: 'delivery.phase.running',
  ready: 'delivery.phase.ready',
  failed: 'delivery.phase.failed',
  stopped: 'delivery.phase.stopped',
  unknown: 'delivery.phase.unknown',
  'accepted-by-user': 'delivery.phase.acceptedByUser',
  rejected: 'delivery.phase.rejected',
};

export function Delivery({
  item,
  observe,
  unsaved = false,
  renderRequests,
}: {
  item: WorkItem;
  observe: (item: WorkItem) => unknown;
  unsaved?: boolean;
  renderRequests?: (runs: readonly string[]) => ReactNode;
}) {
  useLocale();
  const runtime = useRuntime(),
    delivery = useDelivery(item, observe),
    id = useId();
  const [fileError, setFileError] = useState('');
  const [bot, setBot] = useState(item.assignee ?? '');
  const [selected, setSelected] = useState<string>();
  const [checking, setChecking] = useState<{
    attemptId: string;
    revision: number;
    items: string[];
  }>();
  const [reason, setReason] = useState('');
  const [startConsent, setStartConsent] = useState<string>();
  const [decisionConsent, setDecisionConsent] = useState<string>();
  const attempt =
    delivery.page?.attempts.find((entry) => entry.attemptId === selected) ??
    delivery.page?.attempts[0];
  const pendingRequests = (runtime.snapshot.interactions ?? []).filter(
    (request) =>
      request.status === 'pending' &&
      !!attempt &&
      ((request.bot === attempt.bot && request.runId === attempt.runId) ||
        attempt.results.some(
          (result) => result.bot === request.bot && result.runId === request.runId,
        )),
  );
  // Consent belongs to the exact versions displayed, including an empty acceptance checklist.
  const startVersion = `${item.id}:${item.revision}:${delivery.page?.checklist.revision}:${bot}`;
  const decisionVersion = attempt ? `${attempt.attemptId}:${attempt.revision}` : undefined;
  const startConfirmed = startConsent === startVersion;
  const confirmed = !!decisionVersion && decisionConsent === decisionVersion;
  const setStartConfirmed = (value: boolean) => setStartConsent(value ? startVersion : undefined);
  const setConfirmed = (value: boolean) => setDecisionConsent(value ? decisionVersion : undefined);
  const disabled =
    delivery.busy || !!delivery.draft.pending || delivery.blocked || unsaved || item.deleted;
  const active = delivery.page?.attempts.some(
    (entry) => ['accepted', 'running', 'ready', 'unknown'].includes(entry.phase) && !entry.decision,
  );
  const checked =
    attempt?.decision?.checked ??
    (checking && checking.attemptId === attempt?.attemptId ? checking.items : []);
  const stale =
    !!attempt && !attempt.decision && checked.length > 0 && checking?.revision !== attempt.revision;
  const mutate = (index: number, patch: Partial<DeliveryCriterion>) =>
    delivery.edit(
      delivery.draft.checklist.items.map((entry, position) =>
        position === index ? { ...entry, ...patch } : entry,
      ),
    );
  const move = (index: number, direction: number) => {
    const items = [...delivery.draft.checklist.items];
    [items[index], items[index + direction]] = [items[index + direction], items[index]];
    delivery.edit(items);
  };
  const decide = async (action: 'accept' | 'reject' | 'close-unknown', entry: DeliveryAttempt) => {
    await delivery.send({
      type: 'delivery.decide',
      request: { ...delivery.target(entry), action, checked, reason, confirmed },
    });
  };
  return (
    <section className="delivery" aria-labelledby={`${id}-title`}>
      <header>
        <h3 id={`${id}-title`}>{t('delivery.title')}</h3>
        {delivery.available && (
          <button
            type="button"
            className="icon-button"
            aria-label={t('delivery.refresh')}
            onClick={() => delivery.load().catch(() => {})}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        )}
      </header>
      {!delivery.available ? (
        <p className="field-help">{t('delivery.unavailable')}</p>
      ) : (
        <>
          <p className="field-help">{t('delivery.saveHint')}</p>
          {fileError && (
            <p role="alert" className="form-error">
              {t('delivery.error', { 0: fileError })}
            </p>
          )}
          {delivery.error && (
            <p role="alert" className="form-error">
              {t('delivery.error', { 0: delivery.error })}
            </p>
          )}
          {delivery.draft.pending && (
            <div role="status">
              <p>{t('delivery.pending')}</p>
              <button
                type="button"
                disabled={delivery.busy}
                onClick={() => delivery.check().catch(() => {})}
              >
                {t('delivery.queryReceipt')}
              </button>
            </div>
          )}
          {unsaved && <p role="status">{t('delivery.saveCardFirst')}</p>}
          <details open={!attempt || delivery.dirty}>
            <summary>{t('delivery.checklist')}</summary>
            <fieldset disabled={disabled}>
              <legend>{t('delivery.checklist')}</legend>
              {delivery.draft.checklist.items.map((criterion, index) => (
                <div className="delivery-criterion" key={criterion.id}>
                  <label htmlFor={`${id}-${criterion.id}`}>
                    {t('delivery.criterion', { 0: index + 1 })}
                  </label>
                  <textarea
                    id={`${id}-${criterion.id}`}
                    maxLength={600}
                    value={criterion.text}
                    onChange={(event) => mutate(index, { text: event.target.value })}
                    rows={2}
                  />
                  <div className="delivery-actions">
                    <label>
                      {t('delivery.kind')}
                      <select
                        value={criterion.kind}
                        onChange={(event) =>
                          mutate(index, { kind: event.target.value as 'text' | 'file' })
                        }
                      >
                        <option value="text">{t('delivery.text')}</option>
                        <option value="file">{t('delivery.file')}</option>
                      </select>
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={criterion.required}
                        onChange={(event) => mutate(index, { required: event.target.checked })}
                      />
                      {t('delivery.required')}
                    </label>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t('delivery.moveUp', { 0: index + 1 })}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ChevronUp aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t('delivery.moveDown', { 0: index + 1 })}
                      disabled={index === delivery.draft.checklist.items.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ChevronDown aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t('delivery.remove', { 0: index + 1 })}
                      onClick={() =>
                        delivery.edit(
                          delivery.draft.checklist.items.filter(
                            (entry) => entry.id !== criterion.id,
                          ),
                        )
                      }
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))}
              <div className="delivery-actions">
                <button
                  type="button"
                  disabled={delivery.draft.checklist.items.length >= 20}
                  onClick={() =>
                    delivery.edit([
                      ...delivery.draft.checklist.items,
                      { id: crypto.randomUUID(), text: '', kind: 'text', required: true },
                    ])
                  }
                >
                  <Plus aria-hidden="true" />
                  {t('delivery.add')}
                </button>
                <button
                  type="button"
                  disabled={
                    !delivery.dirty ||
                    !delivery.page ||
                    delivery.draft.checklist.items.some(
                      (entry) => !entry.text.trim() || Array.from(entry.text).length > 300,
                    )
                  }
                  onClick={() => delivery.save().catch(() => {})}
                >
                  {t('delivery.saveChecklist')}
                </button>
                {delivery.page &&
                  delivery.draft.checklist.revision !== delivery.page.checklist.revision && (
                    <button type="button" onClick={delivery.reset}>
                      {t('delivery.useLatest')}
                    </button>
                  )}
              </div>
            </fieldset>
          </details>
          <fieldset
            disabled={
              disabled ||
              !!active ||
              !delivery.page ||
              delivery.dirty ||
              ['done', 'closed'].includes(item.status)
            }
          >
            <legend>{t('delivery.start')}</legend>
            <label htmlFor={`${id}-bot`}>{t('delivery.bot')}</label>
            <select
              id={`${id}-bot`}
              value={bot}
              onChange={(event) => {
                setBot(event.target.value);
                setStartConfirmed(false);
              }}
            >
              <option value="">{t('delivery.chooseBot')}</option>
              {runtime.snapshot.profiles
                .filter((profile) => !profile.archived)
                .map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
            </select>
            <p className="field-help">
              {t('delivery.startSnapshot', {
                0: item.title,
                1: item.revision,
                2: delivery.page?.checklist.revision ?? 0,
              })}
            </p>
            <label>
              <input
                type="checkbox"
                checked={startConfirmed}
                onChange={(event) => setStartConfirmed(event.target.checked)}
              />
              {t('delivery.startConfirm')}
            </label>
            <button
              type="button"
              disabled={!bot || !startConfirmed}
              onClick={() => {
                setStartConfirmed(false);
                setSelected(undefined);
                setChecking(undefined);
                delivery
                  .send({
                    type: 'delivery.start',
                    request: {
                      requestId: crypto.randomUUID(),
                      workId: item.id,
                      workRevision: item.revision,
                      checklistRevision: delivery.page!.checklist.revision,
                      bot,
                    },
                  })
                  .catch(() => {});
              }}
            >
              {t('delivery.start')}
            </button>
          </fieldset>
          {!!delivery.page && !delivery.page.attempts.length && (
            <p className="field-help">{t('delivery.noAttempts')}</p>
          )}
          {delivery.page && delivery.page.attempts.length > 0 && (
            <label>
              {t('delivery.history')}
              <select
                value={attempt?.attemptId}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setChecking(undefined);
                  setReason('');
                  setConfirmed(false);
                }}
              >
                {delivery.page.attempts.map((entry) => (
                  <option key={entry.attemptId} value={entry.attemptId}>
                    {entry.title} · {t(phaseMessages[entry.phase])} · {entry.createdAt}
                  </option>
                ))}
              </select>
            </label>
          )}
          {delivery.page?.nextBefore && (
            <button type="button" onClick={() => delivery.load(true).catch(() => {})}>
              {t('delivery.more')}
            </button>
          )}
          {attempt && (
            <article className="delivery-attempt">
              {!!pendingRequests.length && (
                <>
                  <p role="status">
                    {t(
                      pendingRequests.some((request) => request.kind === 'question')
                        ? 'delivery.questionPending'
                        : 'delivery.approvalPending',
                    )}
                  </p>
                  {renderRequests?.([...new Set(pendingRequests.map((request) => request.runId))])}
                </>
              )}
              <p role="status">
                <strong>{t(phaseMessages[attempt.phase])}</strong> ·{' '}
                {t('delivery.version', { 0: attempt.revision })}
              </p>
              {((attempt.workRevision !== item.revision &&
                attempt.ownershipRevision !== item.revision) ||
                attempt.checklist.revision !== delivery.page?.checklist.revision) && (
                <p role="status">{t('delivery.snapshotChanged')}</p>
              )}
              <p>
                <strong>{attempt.title}</strong>
              </p>
              <p className="delivery-copy">{attempt.description}</p>
              {attempt.error && <p role="alert">{t('delivery.error', { 0: attempt.error })}</p>}
              {attempt.results.map((result) => (
                <details key={`${result.bot}:${result.runId}`}>
                  <summary>
                    {t('delivery.modelReport')} · {result.bot}
                  </summary>
                  <p className="delivery-copy">{result.text}</p>
                </details>
              ))}
              {attempt.groups.map((group) => (
                <p key={group.sourceId}>{t('delivery.group', { 0: group.groupId })}</p>
              ))}
              {attempt.outputs.map((output) => (
                <p key={`${output.bot}:${output.runId}:${output.path}`}>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const file = await runtime.command({
                          type: 'files.download',
                          path: output.path,
                        });
                        if (!isRuntimeDownload(file) || file.path !== output.path)
                          throw new Error('DELIVERY_FILE_UNAVAILABLE');
                        downloadBlob(
                          file.name,
                          new Blob(
                            [
                              Uint8Array.from(atob(file.data), (character) =>
                                character.charCodeAt(0),
                              ),
                            ],
                            { type: 'application/octet-stream' },
                          ),
                        );
                        setFileError('');
                      } catch (cause) {
                        setFileError(runtimeError(cause));
                      }
                    }}
                  >
                    {t('delivery.downloadCurrent', { 0: output.path })}
                  </button>
                </p>
              ))}
              {attempt.checklist.items.map((criterion) => {
                const evidence = attempt.evidence.find(
                  (entry): entry is DeliveryFileEvidence =>
                    entry.source === 'file-check' && entry.criterionId === criterion.id,
                );
                return (
                  <div className="delivery-criterion" key={criterion.id}>
                    <label>
                      <input
                        type="checkbox"
                        disabled={
                          disabled || attempt.phase !== 'ready' || stale || !!attempt.decision
                        }
                        checked={checked.includes(criterion.id)}
                        onChange={(event) =>
                          setChecking({
                            attemptId: attempt.attemptId,
                            revision: attempt.revision,
                            items: event.target.checked
                              ? [...checked, criterion.id]
                              : checked.filter((id) => id !== criterion.id),
                          })
                        }
                      />
                      {criterion.text}
                    </label>
                    {criterion.kind === 'text' &&
                      attempt.evidence
                        .filter(
                          (entry) =>
                            entry.source === 'model-report' && entry.criterionId === criterion.id,
                        )
                        .map((entry) => (
                          <p key={entry.criterionId} className="field-help">
                            {t('delivery.modelReport')} · {entry.bot} · {entry.runId}
                          </p>
                        ))}
                    {criterion.kind === 'file' && (
                      <>
                        <p className="field-help">
                          {evidence
                            ? `${t(evidence.available ? 'delivery.fileChecked' : 'delivery.fileUnavailable')} · ${evidence.path} · ${evidence.size} B · SHA-256 ${evidence.sha256}`
                            : t('delivery.bindHint')}
                        </p>
                        <label>
                          {t('delivery.output')}
                          <select
                            disabled={disabled || attempt.phase !== 'ready' || !!attempt.decision}
                            value=""
                            onChange={(event) => {
                              const output = attempt.outputs[Number(event.target.value)];
                              if (output)
                                delivery
                                  .send({
                                    type: 'delivery.file.bind',
                                    request: {
                                      ...delivery.target(attempt),
                                      criterionId: criterion.id,
                                      output,
                                    },
                                  })
                                  .catch(() => {});
                            }}
                          >
                            <option value="">{t('delivery.selectOutput')}</option>
                            {attempt.outputs.map((output, index) => (
                              <option
                                key={`${output.bot}:${output.runId}:${output.path}`}
                                value={index}
                              >
                                {output.bot} · {output.runId} · {output.path}
                              </option>
                            ))}
                          </select>
                        </label>
                      </>
                    )}
                  </div>
                );
              })}
              {stale && (
                <div role="status">
                  <p>{t('delivery.staleChecks')}</p>
                  <button
                    type="button"
                    onClick={() =>
                      setChecking({
                        attemptId: attempt.attemptId,
                        revision: attempt.revision,
                        items: [],
                      })
                    }
                  >
                    {t('delivery.reviewAgain')}
                  </button>
                </div>
              )}
              {attempt.decision ? (
                <p className="delivery-copy">
                  {t('delivery.decision', { 0: attempt.decision.at })} · {attempt.decision.reason}
                </p>
              ) : (
                <>
                  {['accepted', 'running', 'unknown'].includes(attempt.phase) && (
                    <button
                      type="button"
                      disabled={delivery.busy || !!delivery.draft.pending || delivery.blocked}
                      onClick={() =>
                        delivery
                          .send({ type: 'delivery.stop', request: delivery.target(attempt) })
                          .catch(() => {})
                      }
                    >
                      {t('delivery.stop')}
                    </button>
                  )}
                  {['ready', 'unknown'].includes(attempt.phase) && (
                    <fieldset disabled={disabled || item.status === 'closed'}>
                      <legend>{t('delivery.decisionTitle')}</legend>
                      <label htmlFor={`${id}-reason`}>{t('delivery.reason')}</label>
                      <textarea
                        id={`${id}-reason`}
                        value={reason}
                        maxLength={2000}
                        onChange={(event) => setReason(event.target.value)}
                        rows={2}
                      />
                      <label>
                        <input
                          type="checkbox"
                          checked={confirmed}
                          onChange={(event) => setConfirmed(event.target.checked)}
                        />
                        {t(
                          attempt.phase === 'unknown'
                            ? 'delivery.closeConfirm'
                            : 'delivery.acceptConfirm',
                        )}
                      </label>
                      {attempt.phase === 'ready' ? (
                        <div className="delivery-actions">
                          <button
                            type="button"
                            disabled={
                              !confirmed ||
                              stale ||
                              attempt.checklist.items.some(
                                (entry) =>
                                  !checked.includes(entry.id) ||
                                  (entry.required &&
                                    entry.kind === 'file' &&
                                    !attempt.evidence.some(
                                      (evidence) =>
                                        evidence.source === 'file-check' &&
                                        evidence.criterionId === entry.id &&
                                        evidence.available,
                                    )),
                              )
                            }
                            onClick={() => decide('accept', attempt).catch(() => {})}
                          >
                            {t('delivery.accept')}
                          </button>
                          <button
                            type="button"
                            disabled={!confirmed || !reason.trim()}
                            onClick={() => decide('reject', attempt).catch(() => {})}
                          >
                            {t('delivery.reject')}
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={!confirmed || !reason.trim() || !attempt.queriedAt}
                          onClick={() => decide('close-unknown', attempt).catch(() => {})}
                        >
                          {t('delivery.closeUnknown')}
                        </button>
                      )}
                    </fieldset>
                  )}
                </>
              )}
            </article>
          )}
        </>
      )}
    </section>
  );
}
