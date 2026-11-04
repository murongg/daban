import {
  type BudgetConfigureRequest,
  type BudgetPrice,
  type BudgetSettings,
  isBudgetConfigure,
  isBudgetSettings,
  modelApi,
} from '@daban/protocol';
import { useEffect, useRef, useState } from 'react';
import { useRuntime } from '../../app/Runtime';
import { Select } from '../../components/controls/Select';
import { type MessageKey, t, useLocale } from '../../i18n/locale';
import { type BudgetDraft, draft, micros, policy, routeLabel } from './draft';
import { Fields } from './Fields';
import { clearPending, readPending, writePending } from './pending';
import './budgets.css';

export function Budgets() {
  useLocale();
  const runtime = useRuntime();
  const [settings, setSettings] = useState<BudgetSettings>();
  const [value, setValue] = useState<BudgetDraft>();
  const [prices, setPrices] = useState<BudgetPrice[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<BudgetConfigureRequest>();
  const [route, setRoute] = useState('');
  const [rates, setRates] = useState({ input: '', output: '', cacheRead: '', cacheWrite: '' });
  const epoch = useRef(0);
  const [reload, setReload] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit reload discards a stale read and reconciles the exact persisted settings receipt.
  useEffect(() => {
    const ticket = ++epoch.current;
    setSettings(undefined);
    setValue(undefined);
    setPending(undefined);
    setPrices([]);
    setError('');
    setNotice('');
    runtime
      .command({ type: 'budget.settings' })
      .then((result) => {
        if (ticket !== epoch.current) return;
        if (!isBudgetSettings(result)) throw new Error('INVALID_BUDGET_SETTINGS');
        const saved = readPending(`budget-defaults:${result.scope}`);
        const request =
          isBudgetConfigure(saved) && saved.scope === result.scope ? saved : undefined;
        setSettings(result);
        setValue(draft(request?.policy ?? result.policy));
        setPrices(request?.prices ?? result.prices);
        setPending(request);
      })
      .catch(() => {
        if (ticket === epoch.current) setError(t('budgets.unavailable'));
      });
    return () => {
      epoch.current++;
    };
  }, [runtime.command, reload]);
  const routes = (runtime.snapshot.model.connections ?? []).flatMap((connection) =>
    connection.models.map((model) => ({
      value: JSON.stringify([
        connection.id,
        modelApi(connection),
        modelApi(connection) === 'google-generative-ai'
          ? model.id.replace(/^models\//, '')
          : model.id,
        runtime.snapshot.model.revision ?? 0,
      ]),
      label: `${connection.name} · ${model.name ?? model.id}`,
    })),
  );
  const save = async () => {
    if (!settings || !value || busy) return;
    const ticket = epoch.current;
    let request: BudgetConfigureRequest;
    try {
      const next = policy(value);
      if (next.mode === 'strict' && (next.maxTokens !== undefined || next.money))
        throw new Error('STRICT_UNAVAILABLE');
      request = pending ?? {
        scope: settings.scope,
        id: crypto.randomUUID(),
        revision: settings.revision,
        policy: next,
        prices,
      };
      if (!isBudgetConfigure(request)) throw new Error('INVALID_BUDGET_SETTINGS');
    } catch {
      setError(t('budgets.invalid'));
      return;
    }
    try {
      writePending(`budget-defaults:${settings.scope}`, request);
    } catch {
      setError(t('budgets.saveFailed'));
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    setPending(request);
    try {
      const result = await runtime.command({ type: 'budget.configure', request });
      if (ticket !== epoch.current) return;
      if (
        !isBudgetSettings(result) ||
        result.scope !== request.scope ||
        result.revision !== request.revision + 1
      )
        throw new Error('INVALID_BUDGET_ACK');
      clearPending(`budget-defaults:${settings.scope}`);
      setSettings(result);
      setValue(draft(result.policy));
      setPrices(result.prices);
      setPending(undefined);
      setNotice(t('budgets.saved'));
    } catch {
      if (ticket === epoch.current) setError(t('budgets.saveFailed'));
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  };
  const labels: { key: keyof typeof rates; label: MessageKey }[] = [
    { key: 'input', label: 'budgets.priceInput' },
    { key: 'output', label: 'budgets.priceOutput' },
    { key: 'cacheRead', label: 'budgets.priceRead' },
    { key: 'cacheWrite', label: 'budgets.priceWrite' },
  ];
  return (
    <section className="settings-section budget-settings" aria-label={t('budgets.title')}>
      <h2>{t('budgets.defaults')}</h2>
      <p className="field-help">{t('budgets.defaultsHelp')}</p>
      <p className="field-help">{t('budgets.strictUnavailable')}</p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="field-help">
          {notice}
        </p>
      )}
      {settings && value && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save().catch(() => setError(t('budgets.saveFailed')));
          }}
        >
          <fieldset className="model-fields" disabled={busy || !!pending}>
            <Fields value={value} change={setValue} />
            <h3>{t('budgets.prices')}</h3>
            <p className="field-help">{t('budgets.pricesHelp')}</p>
            <div className="field-label">
              {t('budgets.route')}
              <Select
                label={t('budgets.route')}
                value={route}
                options={routes}
                disabled={!routes.length}
                onValueChange={setRoute}
              />
            </div>
            <div className="budget-fields">
              {labels.map((item) => (
                <label className="field-label" key={item.key}>
                  {t(item.label)}
                  <input
                    className="field"
                    inputMode="decimal"
                    value={rates[item.key]}
                    onChange={(event) =>
                      setRates({ ...rates, [item.key]: event.currentTarget.value })
                    }
                  />
                </label>
              ))}
            </div>
            <button
              type="button"
              className="text-button"
              disabled={!route}
              onClick={() => {
                try {
                  if (!/^[A-Z]{3}$/.test(value.currency)) throw new Error('INVALID_CURRENCY');
                  const price: BudgetPrice = {
                    id: crypto.randomUUID(),
                    routeKey: route,
                    currency: value.currency,
                    createdAt: new Date().toISOString(),
                    input: micros(rates.input),
                    output: micros(rates.output),
                    cacheRead: micros(rates.cacheRead),
                    cacheWrite: micros(rates.cacheWrite),
                  };
                  setPrices([...prices.filter((item) => item.routeKey !== route), price]);
                  setError('');
                } catch {
                  setError(t('budgets.invalid'));
                }
              }}
            >
              {t('budgets.addPrice')}
            </button>
            {prices.length > 0 && (
              <ul className="budget-prices">
                {prices.map((price) => (
                  <li key={price.id}>
                    <span>
                      {routeLabel(price.routeKey)} · {price.currency} ·{' '}
                      {new Date(price.createdAt).toLocaleString()}
                    </span>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setPrices(prices.filter((item) => item.id !== price.id))}
                    >
                      {t('budgets.removePrice')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          {pending && (
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => {
                clearPending(`budget-defaults:${settings.scope}`);
                setPending(undefined);
                setReload((value) => value + 1);
              }}
            >
              {t('budgets.reload')}
            </button>
          )}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? t('budgets.saving') : pending ? t('budgets.retrySave') : t('budgets.save')}
          </button>
        </form>
      )}
    </section>
  );
}
