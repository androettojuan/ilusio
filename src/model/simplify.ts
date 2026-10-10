/** Simplificación de polilíneas (Douglas-Peucker). */

export interface Pt { x: number; y: number }

const distToSegment = (p: Pt, a: Pt, b: Pt): number => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

/**
 * Quita los puntos que no aportan forma, respetando la tolerancia.
 *
 * Devuelve los índices que sobreviven, no los puntos: quien llama suele
 * necesitar saber cuáles eran para conservar datos asociados.
 */
export function simplifyIndices(points: Pt[], tolerance: number): number[] {
  if (points.length < 3) return points.map((_, i) => i);

  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];

  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let best = -1, bestD = tolerance;
    for (let i = lo + 1; i < hi; i++) {
      const d = distToSegment(points[i], points[lo], points[hi]);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([lo, best], [best, hi]); }
  }

  const out: number[] = [];
  keep.forEach((k, i) => { if (k) out.push(i); });
  return out;
}

export const simplify = <T extends Pt>(points: T[], tolerance: number): T[] =>
  simplifyIndices(points, tolerance).map((i) => points[i]);
