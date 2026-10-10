/** Cuadrícula de fondo del editor de bocetos. */
import type { XY } from './sketchEdit';

/** Separación mínima en píxeles entre líneas de la cuadrícula. */
const MIN_PIXELS = 70;

/**
 * Paso de la cuadrícula para el zoom actual.
 *
 * Siempre un valor "redondo" (…, 1, 2, 5, 10, 20, 50, …): una cuadrícula de
 * 3,7 mm no le sirve a nadie para apoyarse. Se elige el más chico que deje al
 * menos 70 px entre líneas.
 */
export function gridStep(scale: number): number {
  const target = MIN_PIXELS / scale;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  return [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= target) ?? pow * 10;
}

export const nearestGridVertex = (at: XY, step: number): XY => ({
  x: Math.round(at.x / step) * step,
  y: Math.round(at.y / step) * step,
});

/** Vértice de cuadrícula al que engancharía el cursor, o null si está lejos. */
export function snapToGrid(at: XY, step: number, radius: number): XY | null {
  const v = nearestGridVertex(at, step);
  return Math.hypot(v.x - at.x, v.y - at.y) <= radius ? v : null;
}
