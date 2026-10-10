/** Glifos de los features en el historial y el navegador. */
import type { Feature } from '../model/types';

export const FEATURE_GLYPH: Record<Feature['type'], string> = {
  plane: '▱',
  sketch: '✎',
  extrude: '⬒',
  revolve: '◗',
  fillet: '◜',
  chamfer: '◺',
};

export const PLANE_LABEL = { XY: 'XY (planta)', XZ: 'XZ (frente)', YZ: 'YZ (lateral)' } as const;
