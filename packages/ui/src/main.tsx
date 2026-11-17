import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { StoreContext } from './hooks';
import { OfficeStore } from './store';
import { createTransport } from './transport';
import '@fontsource/pixelify-sans/400.css';
import '@fontsource/pixelify-sans/600.css';
import '@fontsource/pixelify-sans/700.css';
import '@fontsource/silkscreen/400.css';
import './styles.css';
import './panels.css';
import './views.css';

const root = createRoot(document.getElementById('root')!);
const transport = createTransport();

if ('error' in transport) {
  root.render(
    <div className="fatal">
      <h1>Agent Office</h1>
      <p>{transport.error}</p>
    </div>,
  );
} else {
  const store = new OfficeStore(transport);
  store.start();
  // Read by the local e2e and screenshot scripts (scripts/*.cjs) to wait for a synced snapshot.
  (window as unknown as { __officeStore?: OfficeStore }).__officeStore = store;
  root.render(
    <StrictMode>
      <StoreContext.Provider value={store}>
        <App />
      </StoreContext.Provider>
    </StrictMode>,
  );
}
