import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { installPeer } from './remote/peer';
import './styles/styles.css';

if (window.daban?.peer) installPeer(window.daban.peer);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
