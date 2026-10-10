/**
 * Selección por ventana.
 *
 * Convención de CAD: arrastrar hacia la derecha selecciona sólo lo que queda
 * entero adentro ("ventana"); hacia la izquierda, todo lo que la ventana toque
 * ("cruce"). Es la diferencia entre sacar una figura completa y cortar por el
 * medio de un dibujo.
 */
import { curveToPolyline, type P2, type SolvedCurve } from '../kernel/sketch';

export interface Rect { minX: number; maxX: number; minY: number; maxY: number }

export const rectFrom = (a: P2, b: P2): Rect => ({
  minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
  minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y),
});

export const pointInRect = (p: P2, r: Rect) =>
  p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;

/** ¿Los dos segmentos se cruzan? */
function segmentsCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const side = (p: P2, q: P2, t: P2) =>
    Math.sign((q.x - p.x) * (t.y - p.y) - (q.y - p.y) * (t.x - p.x));
  return side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);
}

export function segmentCrossesRect(a: P2, b: P2, r: Rect): boolean {
  if (pointInRect(a, r) || pointInRect(b, r)) return true;
  const corners: P2[] = [
    { x: r.minX, y: r.minY }, { x: r.maxX, y: r.minY },
    { x: r.maxX, y: r.maxY }, { x: r.minX, y: r.maxY },
  ];
  return corners.some((c, i) => segmentsCross(a, b, c, corners[(i + 1) % 4]));
}

export interface BoxSelectInput {
  curves: SolvedCurve[];
  /** Posición resuelta de cada punto del boceto, por id. */
  points: Map<string, P2>;
  rect: Rect;
  /** true = cruce (todo lo que toque); false = ventana (sólo lo entero). */
  crossing: boolean;
}

/** Ids de lo que cae dentro de la ventana. */
export function selectInBox({ curves, points, rect, crossing }: BoxSelectInput): string[] {
  const hits: string[] = [];

  for (const [id, p] of points) if (pointInRect(p, rect)) hits.push(id);

  for (const curve of curves) {
    const poly = curveToPolyline(curve, 64);
    const touches = crossing
      ? poly.some((p, i) =>
          pointInRect(p, rect)
          || (i < poly.length - 1 && segmentCrossesRect(p, poly[i + 1], rect)))
      : poly.every((p) => pointInRect(p, rect));
    if (touches) hits.push(curve.id);
  }

  return hits;
}
