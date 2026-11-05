import { useEffect, useRef, useState } from 'react';
import { applyGalleryTheme } from './appearance';
import { useMessages } from './Messages';
import { Icon } from './Ui';

export function Theme() {
  const t = useMessages();
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const explicit = useRef(false);
  useEffect(() => {
    const initial = applyGalleryTheme();
    explicit.current = initial.explicit;
    setTheme(initial.theme);
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const change = () => {
      if (!explicit.current) setTheme(applyGalleryTheme().theme);
    };
    media?.addEventListener('change', change);
    return () => media?.removeEventListener('change', change);
  }, []);
  const label = t(theme === 'dark' ? 'gallery.lightTheme' : 'gallery.darkTheme');
  return (
    <button
      type="button"
      className="icon-button theme-toggle"
      aria-label={label}
      title={label}
      onClick={() => {
        const next = applyGalleryTheme(theme === 'dark' ? 'light' : 'dark');
        explicit.current = next.explicit;
        setTheme(next.theme);
      }}
    >
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
    </button>
  );
}
