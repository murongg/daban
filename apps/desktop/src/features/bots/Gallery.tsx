import { ArrowRight, Search } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Dialog } from '../../components/controls/Dialog';
import { t, useLocale } from '../../i18n/locale';
import { Avatar } from './Avatar';
import { type BotPreset, localizePreset, presets } from './presets';

const categories = ['common.all', ...new Set(presets.map((preset) => preset.category))] as const;
export function Gallery({ onUsePreset }: { onUsePreset: (preset: BotPreset) => unknown }) {
  useLocale();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<(typeof categories)[number]>('common.all');
  const [selectedId, setSelected] = useState<string>();
  const selectedSource = presets.find((preset) => preset.id === selectedId);
  const selected = selectedSource && localizePreset(selectedSource);
  // Runtime polling must not restart Dialog's focus trap or move the user's keyboard focus.
  const close = useCallback(() => setSelected(undefined), []);
  const visible = presets
    .filter(
      (preset) =>
        (category === 'common.all' || category === preset.category) &&
        `${t(preset.name)} ${t(preset.description)} ${t(preset.category)}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    )
    .map(localizePreset);
  return (
    <section className="gallery" aria-label={t('gallery.botPresets')}>
      <div className="gallery-intro">
        <h2>{t('gallery.pickCompanionGetWork')}</h2>
        <p>{t('gallery.botsPresetRolesCustomizeThemAdding')}</p>
      </div>
      <div className="gallery-toolbar">
        <label className="gallery-search">
          <Search aria-hidden="true" />
          <span className="sr-only">{t('gallery.searchBotPresets')}</span>
          <input
            type="search"
            placeholder={t('gallery.searchNamePurpose')}
            maxLength={100}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <fieldset className="gallery-categories" aria-label={t('gallery.presetCategories')}>
          {categories.map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={category === value}
              onClick={() => setCategory(value)}
            >
              {t(value)}
            </button>
          ))}
        </fieldset>
      </div>
      <ul className="gallery-list">
        {visible.map((preset) => (
          <li key={preset.id}>
            <button
              type="button"
              className="gallery-bot"
              aria-label={t('common.view', { 0: preset.name })}
              onClick={() => setSelected(preset.id)}
            >
              <Avatar bot={preset} size="large" />
              <span className="gallery-copy">
                <strong>{preset.name}</strong>
                <span>{preset.description}</span>
                <small>{preset.category}</small>
              </span>
              <ArrowRight aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      {!visible.length && (
        <div className="gallery-empty">
          <h3>{t('gallery.noSuitableBotsFound')}</h3>
          <p>{t('gallery.tryAnotherKeywordBrowseOtherCategories')}</p>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setQuery('');
              setCategory('common.all');
            }}
          >
            {t('gallery.viewAllPresets')}
          </button>
        </div>
      )}
      <p className="gallery-note">{t('gallery.addingCreatesIndependentBotConnectComputerLater')}</p>
      {selected && (
        <Dialog title={selected.name} onClose={close}>
          <div className="preset-summary">
            <Avatar bot={selected} size="large" />
            <p>{selected.description}</p>
          </div>
          <h3 className="preset-heading">{t('gallery.tryStarting')}</h3>
          <ul className="preset-prompts">
            {selected.prompts.map((prompt) => (
              <li key={prompt}>{prompt}</li>
            ))}
          </ul>
          <h3 className="preset-heading">{t('gallery.presetRole')}</h3>
          <p className="preset-instructions">{selected.instructions}</p>
          <div className="dialog-actions">
            <button type="button" className="text-button" onClick={close}>
              {t('gallery.backGallery')}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                const preset = selected;
                close();
                onUsePreset(preset);
              }}
            >
              {t('gallery.useBot')}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
