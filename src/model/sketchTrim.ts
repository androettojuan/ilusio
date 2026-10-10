/**
 * Recortar (trim).
 *
 * Se calcula dónde corta la curva elegida al resto, se la parte en esos puntos
 * y se borra sólo el tramo donde hizo clic el usuario. Si no cruza nada, se
 * borra entera, que es lo que espera cualquiera que venga de un CAD.
 */
import type { SketchItem } from './types';
import type { SolvedSketch } from '../kernel/sketch';
import {
  EPS, intersectPoints, paramAt, pointAtParam, pointOnPolyline,
  splineSamples, type Spline,
} from '../kernel/curves';
import {
  cascadeDelete, deletePrimitives, findPrim, freshId, pruneOrphanPoints, type XY,
} from './sketchEdit';
import { simplifyIndices } from './simplify';

export interface TrimResult {
  primitives: SketchItem[];
  error?: string;
}

/** Muestras por tramo al reconstruir un pedazo recortado. */
const RESAMPLE_PER_SPAN = 6;

interface Split { t: number; at: XY }

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
