/**
 * Geometría de curvas resueltas: parametrización, muestreo e intersecciones.
 *
 * Lo usan el recorte y la descomposición en perfiles. Vive en el kernel para
 * que los dos lo compartan sin que el modelo y el kernel se importen en
 * círculo.
 */
import type { P2 as XY, SolvedCurve } from './sketch';
import { curveToPolyline, splinePolyline } from './sketch';

export type Spline = Extract<SolvedCurve, { kind: 'spline' }>;
export type Analytic = Exclude<SolvedCurve, { kind: 'spline' }>;

export const isAnalytic = (c: SolvedCurve): c is Analytic => c.kind !== 'spline';

export const EPS = 1e-7;

/**
 * Muestras por tramo de la polilínea interna con la que se ubica el corte.
 * Más fina que la del dibujo porque acá define la precisión del recorte: el
 * error cae con el cuadrado del paso, y con 48 queda en el orden del micrón.
 */
export const SPLINE_PER_SPAN = 48;



/** Polilínea interna de una curva por puntos, siempre con el mismo muestreo. */
export const splineSamples = (c: Spline) =>
  splinePolyline(c.through, c.periodic, SPLINE_PER_SPAN);

const norm = (a: number) => {
  const two = 2 * Math.PI;
  return ((a % two) + two) % two;
};

/** Parámetro normalizado 0..1 del punto más cercano sobre la polilínea. */
export function paramOnPolyline(poly: XY[], p: XY): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < bestD) { bestD = d; best = (i + t) / (poly.length - 1); }
  }
  return best;
}

export function pointOnPolyline(poly: XY[], t: number): XY {
  const n = poly.length - 1;
  const raw = Math.max(0, Math.min(n, t * n));
  const i = Math.min(n - 1, Math.floor(raw));
  const f = raw - i;
  return {
    x: poly[i].x + (poly[i + 1].x - poly[i].x) * f,
    y: poly[i].y + (poly[i + 1].y - poly[i].y) * f,
  };
}

/** Parámetro normalizado 0..1 del punto más cercano sobre la curva. */
export function paramAt(curve: SolvedCurve, p: XY): number {
  if (curve.kind === 'spline') return paramOnPolyline(splineSamples(curve), p);
  if (curve.kind === 'line') {
    const dx = curve.b.x - curve.a.x, dy = curve.b.y - curve.a.y;
    const len2 = dx * dx + dy * dy || 1;
    return ((p.x - curve.a.x) * dx + (p.y - curve.a.y) * dy) / len2;
  }
  const a = norm(Math.atan2(p.y - curve.c.y, p.x - curve.c.x));
  if (curve.kind === 'circle') return a / (2 * Math.PI);
  const a0 = norm(curve.a0);
  let span = norm(curve.a1) - a0;
  if (span <= EPS) span += 2 * Math.PI;
  let rel = a - a0;
  if (rel < 0) rel += 2 * Math.PI;
  return rel / span;
}

export function pointAtParam(curve: SolvedCurve, t: number): XY {
  if (curve.kind === 'spline') return pointOnPolyline(splineSamples(curve), t);
  if (curve.kind === 'line') {
    return {
      x: curve.a.x + (curve.b.x - curve.a.x) * t,
      y: curve.a.y + (curve.b.y - curve.a.y) * t,
    };
  }
  let angle: number;
  if (curve.kind === 'circle') angle = t * 2 * Math.PI;
  else {
    const a0 = norm(curve.a0);
    let span = norm(curve.a1) - a0;
    if (span <= EPS) span += 2 * Math.PI;
    angle = a0 + span * t;
  }
  return { x: curve.c.x + curve.r * Math.cos(angle), y: curve.c.y + curve.r * Math.sin(angle) };
}

/**
 * ¿El punto cae sobre el tramo dibujado de la curva?
 *
 * Los extremos cuentan: una línea que termina justo sobre otra curva igual la
 * corta. Los cortes degenerados (en el extremo de la curva que se recorta) los
 * descarta después `trimAt`.
 */
export function onCurve(curve: SolvedCurve, p: XY): boolean {
  if (curve.kind === 'circle') return true;
  if (curve.kind === 'spline' && curve.periodic) return true;
  const t = paramAt(curve, p);
  return t > -EPS && t < 1 + EPS;
}

/** Cortes entre dos polilíneas, segmento contra segmento. */
function polylineIntersections(pa: XY[], pb: XY[]): XY[] {
  const out: XY[] = [];
  for (let i = 0; i < pa.length - 1; i++) {
    const p = pa[i];
    const r = { x: pa[i + 1].x - p.x, y: pa[i + 1].y - p.y };
    for (let j = 0; j < pb.length - 1; j++) {
      const q = pb[j];
      const s2 = { x: pb[j + 1].x - q.x, y: pb[j + 1].y - q.y };
      const cross = r.x * s2.y - r.y * s2.x;
      if (Math.abs(cross) < 1e-12) continue;
      const t = ((q.x - p.x) * s2.y - (q.y - p.y) * s2.x) / cross;
      const u = ((q.x - p.x) * r.y - (q.y - p.y) * r.x) / cross;
      if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) continue;
      out.push({ x: p.x + t * r.x, y: p.y + t * r.y });
    }
  }
  return out;
}

/** Muestreo denso para intersecar: el error queda muy por debajo del micrón. */
const denseSamples = (c: SolvedCurve): XY[] =>
  c.kind === 'spline'
    ? splinePolyline(c.through, c.periodic, 64)
    : curveToPolyline(c, 512);

function analyticIntersections(a: Analytic, b: Analytic): XY[] {
  const out: XY[] = [];

  if (a.kind === 'line' && b.kind === 'line') {
    const r = { x: a.b.x - a.a.x, y: a.b.y - a.a.y };
    const s = { x: b.b.x - b.a.x, y: b.b.y - b.a.y };
    const cross = r.x * s.y - r.y * s.x;
    if (Math.abs(cross) < EPS) return out;
    const t = ((b.a.x - a.a.x) * s.y - (b.a.y - a.a.y) * s.x) / cross;
    out.push({ x: a.a.x + t * r.x, y: a.a.y + t * r.y });
  } else if (a.kind === 'line' || b.kind === 'line') {
    const line = (a.kind === 'line' ? a : b) as Extract<SolvedCurve, { kind: 'line' }>;
    const circ = (a.kind === 'line' ? b : a) as Extract<SolvedCurve, { r: number }>;
    const d = { x: line.b.x - line.a.x, y: line.b.y - line.a.y };
    const f = { x: line.a.x - circ.c.x, y: line.a.y - circ.c.y };
    const A = d.x * d.x + d.y * d.y;
    const B = 2 * (f.x * d.x + f.y * d.y);
    const C = f.x * f.x + f.y * f.y - circ.r * circ.r;
    const disc = B * B - 4 * A * C;
    if (A < EPS || disc < 0) return out;
    const root = Math.sqrt(disc);
    for (const t of [(-B - root) / (2 * A), (-B + root) / (2 * A)]) {
      out.push({ x: line.a.x + t * d.x, y: line.a.y + t * d.y });
    }
  } else {
    // Dos circunferencias.
    const c1 = a as Extract<SolvedCurve, { r: number }>;
    const c2 = b as Extract<SolvedCurve, { r: number }>;
    const dx = c2.c.x - c1.c.x, dy = c2.c.y - c1.c.y;
    const dist = Math.hypot(dx, dy);
    if (dist < EPS || dist > c1.r + c2.r || dist < Math.abs(c1.r - c2.r)) return out;
    const m = (c1.r * c1.r - c2.r * c2.r + dist * dist) / (2 * dist);
    const h2 = c1.r * c1.r - m * m;
    if (h2 < 0) return out;
    const h = Math.sqrt(h2);
    const mx = c1.c.x + (m * dx) / dist, my = c1.c.y + (m * dy) / dist;
    out.push({ x: mx + (h * dy) / dist, y: my - (h * dx) / dist });
    out.push({ x: mx - (h * dy) / dist, y: my + (h * dx) / dist });
  }

  return out;
}

export function intersectPoints(a: SolvedCurve, b: SolvedCurve): XY[] {
  // Entre curvas analíticas vale la pena resolverlo exacto; si hay una curva
  // por puntos de por medio, se interseca por polilínea densa.
  const raw = a.kind !== 'spline' && b.kind !== 'spline'
    ? analyticIntersections(a, b)
    : polylineIntersections(denseSamples(a), denseSamples(b));

  // Sólo valen los cortes que caen dentro de ambos tramos dibujados.
  return raw.filter((p) => onCurve(a, p) && onCurve(b, p));
}

