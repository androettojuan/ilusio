/**
 * Recortar (trim).
 *
 * Se calcula dónde corta la curva elegida al resto, se la parte en esos puntos
 * y se borra sólo el tramo donde hizo clic el usuario. Si no cruza nada, se
 * borra entera, que es lo que espera cualquiera que venga de un CAD.
 */
import type { SketchItem } from './types';
import {
  curveToPolyline, splinePolyline, type SolvedCurve, type SolvedSketch,
} from '../kernel/sketch';
import {
  cascadeDelete, deletePrimitives, findPrim, freshId, pruneOrphanPoints, type XY,
} from './sketchEdit';
import { simplifyIndices } from './simplify';

const EPS = 1e-7;

/**
 * Muestras por tramo de la polilínea interna con la que se ubica el corte.
 * Más fina que la del dibujo porque acá define la precisión del recorte: el
 * error cae con el cuadrado del paso, y con 48 queda en el orden del micrón.
 */
const SPLINE_PER_SPAN = 48;
/** Muestras por tramo al reconstruir un pedazo recortado (ver splitSpline). */
const RESAMPLE_PER_SPAN = 6;

type Spline = Extract<SolvedCurve, { kind: 'spline' }>;
type Analytic = Exclude<SolvedCurve, { kind: 'spline' }>;

interface Split { t: number; at: XY }

/** Polilínea interna de una curva por puntos, siempre con el mismo muestreo. */
const splineSamples = (c: Spline) =>
  splinePolyline(c.through, c.periodic, SPLINE_PER_SPAN);

const norm = (a: number) => {
  const two = 2 * Math.PI;
  return ((a % two) + two) % two;
};

/** Parámetro normalizado 0..1 del punto más cercano sobre la polilínea. */
function paramOnPolyline(poly: XY[], p: XY): number {
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

function pointOnPolyline(poly: XY[], t: number): XY {
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
function paramAt(curve: SolvedCurve, p: XY): number {
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

function pointAtParam(curve: SolvedCurve, t: number): XY {
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
function onCurve(curve: SolvedCurve, p: XY): boolean {
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

function intersectPoints(a: SolvedCurve, b: SolvedCurve): XY[] {
  // Entre curvas analíticas vale la pena resolverlo exacto; si hay una curva
  // por puntos de por medio, se interseca por polilínea densa.
  const raw = a.kind !== 'spline' && b.kind !== 'spline'
    ? analyticIntersections(a, b)
    : polylineIntersections(denseSamples(a), denseSamples(b));

  // Sólo valen los cortes que caen dentro de ambos tramos dibujados.
  return raw.filter((p) => onCurve(a, p) && onCurve(b, p));
}

export interface TrimResult {
  primitives: SketchItem[];
  error?: string;
}

interface Sample { at: XY; originalIndex?: number }

/**
 * Puntos para reconstruir el pedazo [a, b] de una curva por puntos.
 *
 * Conserva los puntos originales que caen dentro (con su índice, para poder
 * reutilizar su id) y agrega muestras intermedias. La curva nueva interpola la
 * original en muestras densas, así que el pedazo conserva la forma: el error
 * cae con la cuarta potencia del paso, y con 6 muestras por tramo es
 * despreciable.
 */
function resampleSpline(curve: Spline, a: number, b: number): Sample[] {
  const n = curve.through.length;
  const poly = splineSamples(curve);
  const nodeParam = (i: number) => i / (n - 1);

  /** ¿Este parámetro cae justo sobre un punto original? */
  const nodeAt = (t: number): number | undefined => {
    for (let i = 0; i < n; i++) if (Math.abs(t - nodeParam(i)) < 1e-9) return i;
    return undefined;
  };

  // Puntos originales estrictamente dentro del intervalo.
  const inside: Sample[] = [];
  for (let i = 0; i < n; i++) {
    const t = nodeParam(i);
    if (t > a + 1e-9 && t < b - 1e-9) inside.push({ at: curve.through[i], originalIndex: i });
  }

  // Los extremos del intervalo también pueden caer sobre un punto original
  // (es el caso del principio y el final de la curva, que el recorte no tocó).
  // Si no se reutiliza su id, la geometría enganchada ahí queda suelta.
  const endSample = (t: number): Sample => {
    const i = nodeAt(t);
    return i === undefined
      ? { at: pointOnPolyline(poly, t) }
      : { at: curve.through[i], originalIndex: i };
  };

  const stops = [a, ...inside.map((s2) => nodeParam(s2.originalIndex!)), b];
  const dense: Sample[] = [];
  for (let k = 0; k < stops.length - 1; k++) {
    dense.push(k === 0 ? endSample(a) : inside[k - 1]);
    const t0 = stops[k], t1 = stops[k + 1];
    for (let j = 1; j < RESAMPLE_PER_SPAN; j++) {
      dense.push({ at: pointOnPolyline(poly, t0 + ((t1 - t0) * j) / RESAMPLE_PER_SPAN) });
    }
  }
  dense.push(endSample(b));

  // Las muestras densas sirven para no perder la forma, pero dejarlas todas
  // llena el boceto de puntos inútiles: un tramo casi recto no necesita seis
  // por span. Se simplifican por tramos, conservando siempre los puntos
  // originales (su id lo puede estar usando otra geometría).
  const tol = splineTolerance(curve);
  const anchors = new Set([0, dense.length - 1]);
  dense.forEach((s2, i) => { if (s2.originalIndex !== undefined) anchors.add(i); });

  const sorted = [...anchors].sort((x, y) => x - y);
  const out: Sample[] = [dense[sorted[0]]];
  for (let k = 0; k < sorted.length - 1; k++) {
    const run = dense.slice(sorted[k], sorted[k + 1] + 1);
    for (const i of simplifyIndices(run.map((s2) => s2.at), tol).slice(1)) {
      out.push(run[i]);
    }
  }
  return out;
}

/** Cuánto se puede desviar el pedazo reconstruido: 0,5 ‰ del tamaño de la curva. */
function splineTolerance(curve: Spline): number {
  const xs = curve.through.map((p) => p.x);
  const ys = curve.through.map((p) => p.y);
  const diag = Math.hypot(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
  );
  return Math.max(0.01, diag * 0.0005);
}

/** Recorta el tramo de `curveId` que contiene al punto `at`. */
export function trimAt(
  primitives: SketchItem[], solved: SolvedSketch, curveId: string, at: XY,
): TrimResult {
  const target = solved.curves.find((c) => c.id === curveId);
  const prim = findPrim(primitives, curveId);
  if (!target || !prim) return { primitives, error: 'No encontré esa curva' };
  const closed = target.kind === 'circle' || (target.kind === 'spline' && target.periodic);
  const splits: Split[] = [];
  for (const other of solved.curves) {
    if (other.id === curveId) continue;
    for (const p of intersectPoints(target, other)) {
      const t = paramAt(target, p);
      // En una curva abierta, un corte en un extremo no parte nada. En una
      // cerrada el origen del parámetro es arbitrario, así que t=0 sí vale.
      if (closed || (t > EPS && t < 1 - EPS)) splits.push({ t, at: p });
    }
  }

  // Sin cortes, recortar es borrar.
  if (splits.length === 0) {
    return { primitives: deletePrimitives(primitives, [curveId]) };
  }

  splits.sort((x, y) => x.t - y.t);
  // Dos curvas que se cruzan de forma rasante pueden dar varios cortes pegados
  // al intersecar por polilínea; se cuentan como uno solo.
  const merged: Split[] = [];
  for (const sp of splits) {
    if (merged.length === 0 || sp.t - merged[merged.length - 1].t > 1e-4) merged.push(sp);
  }
  splits.length = 0;
  splits.push(...merged);

  // Los extremos cuentan como límites, salvo en una curva cerrada (no tiene).
  const bounds = closed
    ? [...splits, { t: splits[0].t + 1, at: splits[0].at }]
    : [{ t: 0, at: pointAtParam(target, 0) }, ...splits, { t: 1, at: pointAtParam(target, 1) }];

  let clickT = paramAt(target, at);
  if (closed && clickT < bounds[0].t) clickT += 1;

  const segIndex = bounds.findIndex((b, i) =>
    i < bounds.length - 1 && clickT >= b.t && clickT <= bounds[i + 1].t);
  if (segIndex < 0) return { primitives, error: 'El clic cayó fuera de la curva' };

  // Reconstruimos todos los tramos menos el que se recorta. Acá no se puede
  // podar todavía: los puntos de la curva vieja se reutilizan abajo.
  let out = cascadeDelete(primitives, [curveId]);
  const addPoint = (p: XY) => {
    const id = freshId(out, 'p');
    out = [...out, { id, type: 'point', x: p.x, y: p.y, fixed: false }];
    return id;
  };

  for (let i = 0; i < bounds.length - 1; i++) {
    if (i === segIndex) continue;
    const from = bounds[i], to = bounds[i + 1];
    if (to.t - from.t < 1e-6) continue;

    if (target.kind === 'line') {
      // Los puntos se crean ANTES de armar el array: en `[...out, {...}]` el
      // spread se evalúa primero y se perdería lo que agregue addPoint.
      const p1 = addPoint(from.at);
      const p2 = addPoint(to.at);
      out = [...out, {
        id: freshId(out, 'l'), type: 'line', p1_id: p1, p2_id: p2,
      } as SketchItem];
    } else if (target.kind === 'spline') {
      const ids = resampleSpline(target, from.t, to.t).map((sample) => {
        // Los puntos originales que sobreviven conservan su id: si no, la
        // geometría que estaba enganchada a un extremo quedaría suelta.
        if (sample.originalIndex !== undefined) {
          return target.pointIds[sample.originalIndex];
        }
        return addPoint(sample.at);
      });
      if (ids.length >= 2) {
        out = [...out, {
          id: freshId(out, 'sp'), type: 'spline', point_ids: ids, periodic: false,
        } as SketchItem];
      }
    } else {
      const center = addPoint(target.c);
      const s = addPoint(from.at), e = addPoint(to.at);
      const ang = (p: XY) => Math.atan2(p.y - target.c.y, p.x - target.c.x);
      out = [...out, {
        id: freshId(out, 'a'), type: 'arc',
        c_id: center, radius: target.r,
        start_id: s, end_id: e,
        start_angle: ang(from.at), end_angle: ang(to.at),
      } as SketchItem];
    }
  }

  // Los viejos extremos que ya no sostienen nada se van solos.
  return { primitives: pruneOrphanPoints(out) };
}
