import { createRoot } from 'react-dom/client';
import { App } from '../../src/app/App';
import { modelPreview } from '../models';
import '../../src/styles/tokens.css';
import '../../src/styles/styles.css';

// The first-use form runs against the shared synthetic bridge, never a real key store or model API.
const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
const { bridge } = modelPreview(query.get('configured') !== '1');
Object.defineProperty(window, 'daban', {
  configurable: true,
  value: { platform: 'darwin', runtime: bridge },
});
createRoot(document.getElementById('root')!).render(<App />);
