import { agentId, type McpAssignments } from '@daban/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Bot } from '../../app/state';
import { t, useLocale } from '../../i18n/locale';
import { IntegrationTools } from './IntegrationTools';

export function BotTools({ bot, onDirty }: { bot: Bot; onDirty: (dirty: boolean) => unknown }) {
  useLocale();
  const { command, snapshot } = useRuntime();
  const id = agentId(bot.id);
  const [assignments, setAssignments] = useState<McpAssignments>();
  const [selected, setSelected] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const reads = useRef(0);
  const handleDirty = useCallback(
    (value: boolean) => {
      setDirty(value);
      onDirty(value);
    },
    [onDirty],
  );
  const available =
    snapshot.phase === 'ready' &&
    snapshot.protocolVersion >= 21 &&
    snapshot.mcp?.available === true &&
    snapshot.profiles.some((profile) => profile.id === id && !profile.archived) &&
    !bot.archived;
  const revision = snapshot.mcp?.available ? snapshot.mcp.revision : undefined;
  const load = useCallback(async () => {
    const serial = ++reads.current;
    try {
      const value = await command<McpAssignments>({ type: 'mcp.bindings', bot: id });
      if (serial === reads.current) {
        setAssignments(value);
        setError('');
      }
    } catch (cause) {
      if (serial === reads.current) setError(runtimeError(cause));
    }
  }, [command, id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Store revisions refresh the available connections and bindings.
  useEffect(() => {
    if (available) load().catch((cause) => setError(runtimeError(cause)));
    return () => {
      reads.current++;
    };
  }, [available, load, revision]);
  const items = assignments?.bot === id ? assignments.items : [];
  const entry = items.find((item) => item.connection.id === selected);
  return (
    <div className="integration-settings">
      <p className="setting-description">{t('apps.botToolsHint')}</p>
      {!available && <p className="inline-note">{t('apps.botToolsUnavailable')}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {available && assignments && !items.length && (
        <p className="inline-note">{t('apps.noConnectionsForBot')}</p>
      )}
      {items.map((item) => (
        <div className="integration-row" key={item.connection.id}>
          <div className="integration-meta">
            <h3>{item.connection.name}</h3>
            <p className="field-help">
              {t(
                item.available
                  ? 'apps.bound'
                  : item.enabled
                    ? 'apps.bindingNeedsReview'
                    : 'apps.notBound',
              )}
            </p>
          </div>
          <button
            className="secondary"
            type="button"
            aria-label={t('integrations.namedToolsPermissions', { 0: item.connection.name })}
            disabled={!available || dirty}
            onClick={() =>
              setSelected(selected === item.connection.id ? undefined : item.connection.id)
            }
          >
            {t('integrations.toolsPermissions')}
          </button>
        </div>
      ))}
      {entry && (
        <IntegrationTools
          key={entry.connection.id}
          connection={entry.connection}
          bot={bot}
          onChanged={load}
          onDirty={handleDirty}
          onClose={() => setSelected(undefined)}
        />
      )}
    </div>
  );
}
