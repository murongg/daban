import { ArrowRight, Search } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Avatar } from './Avatar';
import { Dialog } from './Dialog';
import { type BotPreset, presets } from './presets';

const categories = ['全部', ...new Set(presets.map((preset) => preset.category))];
export function Gallery({ onUsePreset }: { onUsePreset: (preset: BotPreset) => unknown }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部');
  const [selected, setSelected] = useState<BotPreset>();
  // Runtime polling must not restart Dialog's focus trap or move the user's keyboard focus.
  const close = useCallback(() => setSelected(undefined), []);
  const visible = presets.filter(
    (preset) =>
      (category === '全部' || category === preset.category) &&
      `${preset.name} ${preset.description} ${preset.category}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  return (
    <section className="gallery" aria-label="预设 Bot">
      <div className="gallery-intro">
        <h2>挑一个搭档，开始做事。</h2>
        <p>预设好职责的 Bot，添加后可以继续调整。</p>
      </div>
      <div className="gallery-toolbar">
        <label className="gallery-search">
          <Search aria-hidden="true" />
          <span className="sr-only">搜索预设 Bot</span>
          <input
            type="search"
            placeholder="搜索名称或用途"
            maxLength={100}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <fieldset className="gallery-categories" aria-label="预设分类">
          {categories.map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={category === value}
              onClick={() => setCategory(value)}
            >
              {value}
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
              aria-label={`查看 ${preset.name}`}
              onClick={() => setSelected(preset)}
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
          <h3>没有找到合适的 Bot</h3>
          <p>换个关键词，或看看其他分类。</p>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setQuery('');
              setCategory('全部');
            }}
          >
            查看全部预设
          </button>
        </div>
      )}
      <p className="gallery-note">添加后会创建独立的 Bot。需要操作电脑时，再为它连接电脑。</p>
      {selected && (
        <Dialog title={selected.name} onClose={close}>
          <div className="preset-summary">
            <Avatar bot={selected} size="large" />
            <p>{selected.description}</p>
          </div>
          <h3 className="preset-heading">可以这样开始</h3>
          <ul className="preset-prompts">
            {selected.prompts.map((prompt) => (
              <li key={prompt}>{prompt}</li>
            ))}
          </ul>
          <h3 className="preset-heading">预设职责</h3>
          <p className="preset-instructions">{selected.instructions}</p>
          <div className="dialog-actions">
            <button type="button" className="text-button" onClick={close}>
              返回广场
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
              使用这个 Bot
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
