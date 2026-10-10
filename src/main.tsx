import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { useDocument } from './store/useDocument';

// En desarrollo el store queda accesible desde la consola y desde los tests de
// navegador. Importar el módulo desde fuera no sirve: tras un HMR, Vite entrega
// una instancia distinta.
if (import.meta.env.DEV) {
  (window as unknown as { ilusio: typeof useDocument }).ilusio = useDocument;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
