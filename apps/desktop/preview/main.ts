import { startPreview } from './storage';

const entry = document.querySelector<HTMLScriptElement>('script[data-preview]')?.dataset.preview;
const pages = import.meta.glob('./scenes/*Preview.tsx');
const key = `./scenes/${entry}.tsx`;
if (!Object.hasOwn(pages, key)) throw new Error('UNKNOWN_PREVIEW');
const query = new URLSearchParams(location.search);
const kind = query.get('kind') === 'group' ? 'group' : 'bot';
await startPreview(sessionStorage, `${entry}:${kind}`, pages[key], query.get('lang'));
