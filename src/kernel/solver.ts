// Solver de restricciones 2D (PlaneGCS de FreeCAD compilado a wasm).
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';

let instance: Promise<GcsWrapper> | null = null;

export function getSolver(): Promise<GcsWrapper> {
  if (!instance) instance = make_gcs_wrapper('/wasm/planegcs.wasm');
  return instance;
}
