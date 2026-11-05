// Kept self-contained: the static exporter emits this function as the pre-paint browser script.
export function applyGalleryTheme(choice?: 'light' | 'dark') {
  let selected = choice;
  try {
    const key = 'daban.gallery.theme';
    if (choice) window.localStorage.setItem(key, choice);
    else {
      const saved = window.localStorage.getItem(key);
      if (saved === 'light' || saved === 'dark') selected = saved;
    }
  } catch {
    // Storage can be blocked; manual appearance still works for the current page.
  }
  const theme =
    selected ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
  return { theme, explicit: selected !== undefined };
}
