// Carga OCCT en Node. La beta trae un punto de entrada propio para Node que ya
// resuelve __dirname y la ruta del .wasm.
import initOpenCascade from 'opencascade.js/dist/node.js';
export const loadOCCT = () => initOpenCascade();
