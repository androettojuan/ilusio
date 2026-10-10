import type { OpenCascadeInstance } from 'opencascade.js';
import ocFullJS from 'opencascade.js/dist/opencascade.full.js';

/**
 * El .d.ts generado declara el export por defecto como `init(): Promise<...>`,
 * pero en runtime es una factory de Emscripten que se invoca con `new` y recibe
 * las opciones del módulo. Casteamos a la firma real.
 */
type OcFactory = new (opts: {
  locateFile?: (path: string) => string;
}) => Promise<OpenCascadeInstance>;

let instance: Promise<OpenCascadeInstance> | null = null;

/**
 * Carga OpenCascade una sola vez. El .wasm (50 MB) se sirve como estático desde
 * /public/wasm en vez de pasar por el bundler.
 */
export function getOCCT(): Promise<OpenCascadeInstance> {
  if (!instance) {
    instance = new (ocFullJS as unknown as OcFactory)({
      locateFile: (path) =>
        path.endsWith('.wasm') ? '/wasm/opencascade.full.wasm' : path,
    });
  }
  return instance;
}
