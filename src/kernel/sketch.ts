/**
 * Resolución de bocetos y detección de perfiles.
 *
 * El solver devuelve posiciones sueltas; para extruir hace falta reconstruir
 * los bucles cerrados y saber cuáles son contornos y cuáles agujeros.
 */
import type { SketchPrimitive } from '@salusoft89/planegcs';
import { getSolver } from './solver';
import { isSpline, type SketchFeature, type SketchItem } from '../model/types';

export interface P2 { x: number; y: number }

export type SolvedCurve =
  | { id: string; kind: 'line'; a: P2; b: P2 }
  | { id: string; kind: 'circle'; c: P2; r: number }
  | { id: string; kind: 'arc'; c: P2; r: number; a0: number; a1: number; start: P2; end: P2 }
  /**
   * Curva por puntos: `through` son las posiciones por las que pasa y
   * `pointIds` los puntos del boceto que las originan, en el mismo orden.
   * Recortar necesita los ids para conservar los puntos que sobreviven.
   */
  | { id: string; kind: 'spline'; through: P2[]; pointIds: string[]; periodic: boolean };

export interface SolvedSketch {
  curves: SolvedCurve[];
  points: Map<string, P2>;
  /** 0 = resuelto. Cualquier otro valor viene de SolveStatus de PlaneGCS. */
  status: number;
  conflicting: string[];
  redundant: string[];
  /** Grados de libertad sin restringir, para pintar el boceto de otro color. */
  underConstrained: boolean;
}

const onCircle = (c: P2, r: number, a: number): P2 => ({
  x: c.x + r * Math.cos(a),
  y: c.y + r * Math.sin(a),
});

/** Resuelve las restricciones del boceto y devuelve la geometría ya ubicada. */
export async function solveSketch(
  sketch: SketchFeature,
  parameters: Record<string, number> = {},
): Promise<SolvedSketch> {
  const gcs = await getSolver();
  gcs.clear_data();

  for (const [name, value] of Object.entries(parameters)) {
    gcs.push_sketch_param(name, value, true);
  }
  // Las curvas por puntos no van al solver: sólo sus puntos, que ya están en
  // la lista como primitivas normales.
  const forSolver = sketch.primitives.filter((p) => !isSpline(p)) as SketchPrimitive[];
  gcs.push_primitives_and_params(forSolver);

  const status = gcs.solve();
  gcs.apply_solution();

  const points = new Map<string, P2>();
  const curves: SolvedCurve[] = [];

  for (const prim of sketch.primitives) {
    const p = prim as SketchItem & Record<string, unknown>;
    if (p.type === 'point') {
      const r = gcs.sketch_index.get_sketch_point(p.id as string);
      points.set(p.id as string, { x: r.x, y: r.y });
    }
  }

  const pt = (id: string): P2 => points.get(id) ?? { x: 0, y: 0 };

  for (const prim of sketch.primitives) {
    if (isSpline(prim)) {
      const through = prim.point_ids.map(pt);
      if (through.length >= 2) {
        curves.push({
          id: prim.id, kind: 'spline', through,
          pointIds: prim.point_ids, periodic: prim.periodic,
        });
      }
      continue;
    }
    const p = prim as SketchPrimitive & Record<string, string | number>;
    switch (p.type) {
      case 'line':
        curves.push({ id: p.id as string, kind: 'line', a: pt(p.p1_id as string), b: pt(p.p2_id as string) });
        break;
      case 'circle': {
        const solved = gcs.sketch_index.get_sketch_circle(p.id as string);
        curves.push({ id: p.id as string, kind: 'circle', c: pt(solved.c_id), r: solved.radius });
        break;
      }
      case 'arc': {
        const solved = gcs.sketch_index.get_sketch_arc(p.id as string);
        const c = pt(solved.c_id);
        curves.push({
          id: p.id as string, kind: 'arc', c, r: solved.radius,
          a0: solved.start_angle, a1: solved.end_angle,
          start: onCircle(c, solved.radius, solved.start_angle),
          end: onCircle(c, solved.radius, solved.end_angle),
        });
        break;
      }
    }
  }

  return {
    curves,
    points,
    status,
    conflicting: gcs.get_gcs_conflicting_constraints(),
    redundant: gcs.get_gcs_redundant_constraints(),
    underConstrained: gcs.gcs.dof() > 0,
  };
}

// --------------------------------------------------------------------------
// Detección de bucles
// --------------------------------------------------------------------------

export interface LoopSegment { curve: SolvedCurve; reversed: boolean }

export interface Loop {
  segments: LoopSegment[];
  /** Área con signo: negativa si el bucle gira en sentido horario. */
  signedArea: number;
  /** Polilínea de muestreo, para los tests de contención. */
  polyline: P2[];
}

const TOL = 1e-6;
const key = (p: P2) => `${Math.round(p.x / TOL)}:${Math.round(p.y / TOL)}`;

const endpoints = (c: SolvedCurve): [P2, P2] | null => {
  if (c.kind === 'line') return [c.a, c.b];
  if (c.kind === 'arc') return [c.start, c.end];
  // Una curva por puntos encadena como cualquier otra, salvo que sea cerrada.
  if (c.kind === 'spline' && !c.periodic) {
    return [c.through[0], c.through[c.through.length - 1]];
  }
  return null;
};

/**
 * Catmull-Rom centrípeta por los puntos dados.
 *
 * Sólo para dibujar y para los tests de contención: la geometría real la
 * construye OCCT con una B-spline que pasa por los mismos puntos. A simple
 * vista son indistinguibles.
 */
export function splinePolyline(through: P2[], periodic: boolean, perSpan = 16): P2[] {
  if (through.length < 3) return [...through];
  const pts = periodic ? [...through, through[0]] : through;
  const at = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  const out: P2[] = [pts[0]];

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = periodic && i === 0 ? pts[pts.length - 2] : at(i - 1);
    const p1 = at(i), p2 = at(i + 1);
    const p3 = periodic && i === pts.length - 2 ? pts[1] : at(i + 2);

    // Parametrización centrípeta: evita los rulos de la uniforme.
    const t = [0, 0, 0, 0];
    const quad = [p0, p1, p2, p3];
    for (let k = 1; k < 4; k++) {
      const d = Math.hypot(quad[k].x - quad[k - 1].x, quad[k].y - quad[k - 1].y);
      t[k] = t[k - 1] + Math.sqrt(d) || t[k - 1] + 1e-6;
    }

    for (let s = 1; s <= perSpan; s++) {
      const tt = t[1] + ((t[2] - t[1]) * s) / perSpan;
      const lerp = (a: P2, b: P2, ta: number, tb: number): P2 => {
        const w = tb - ta === 0 ? 0 : (tt - ta) / (tb - ta);
        return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
      };
      const a1 = lerp(p0, p1, t[0], t[1]);
      const a2 = lerp(p1, p2, t[1], t[2]);
      const a3 = lerp(p2, p3, t[2], t[3]);
      const b1 = lerp(a1, a2, t[0], t[2]);
      const b2 = lerp(a2, a3, t[1], t[3]);
      out.push(lerp(b1, b2, t[1], t[2]));
    }
  }
  return out;
}

/** Muestrea una curva como polilínea cerrada o abierta, para dibujar y medir. */
export function curveToPolyline(curve: SolvedCurve, steps = 48): P2[] {
  if (curve.kind === 'line') return [curve.a, curve.b];
  if (curve.kind === 'spline') return splinePolyline(curve.through, curve.periodic);
  if (curve.kind === 'circle') {
    return Array.from({ length: steps + 1 }, (_, i) =>
      onCircle(curve.c, curve.r, (i / steps) * 2 * Math.PI));
  }
  let { a0, a1 } = curve;
  while (a1 <= a0) a1 += 2 * Math.PI;
  return Array.from({ length: steps + 1 }, (_, i) =>
    onCircle(curve.c, curve.r, a0 + ((a1 - a0) * i) / steps));
}

/** Muestrea una curva como polilínea (sin repetir el punto inicial). */
function sample(seg: LoopSegment, steps = 24): P2[] {
  const { curve, reversed } = seg;
  if (curve.kind === 'line') return [reversed ? curve.a : curve.b];
  if (curve.kind === 'spline') {
    const poly = splinePolyline(curve.through, curve.periodic);
    return (reversed ? [...poly].reverse() : poly).slice(1);
  }
  if (curve.kind === 'circle') {
    return Array.from({ length: steps }, (_, i) =>
      onCircle(curve.c, curve.r, ((i + 1) / steps) * 2 * Math.PI));
  }
  let { a0, a1 } = curve;
  while (a1 < a0) a1 += 2 * Math.PI;
  return Array.from({ length: steps }, (_, i) => {
    const t = (i + 1) / steps;
    const a = reversed ? a1 + (a0 - a1) * t : a0 + (a1 - a0) * t;
    return onCircle(curve.c, curve.r, a);
  });
}

function polygonArea(poly: P2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function pointInPolygon(p: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) &&
        p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Agrupa las curvas en bucles cerrados.
 *
 * Los círculos ya son un bucle. El resto se encadena siguiendo extremos
 * coincidentes: las cadenas que no cierran (perfiles abiertos) se descartan,
 * porque no se pueden extruir.
 */
export function findLoops(curves: SolvedCurve[]): Loop[] {
  const loops: Loop[] = [];

  const close = (segments: LoopSegment[]) => {
    const polyline = segments.flatMap((s) => sample(s));
    loops.push({ segments, polyline, signedArea: polygonArea(polyline) });
  };

  for (const c of curves) {
    if (c.kind === 'circle' || (c.kind === 'spline' && c.periodic)) {
      close([{ curve: c, reversed: false }]);
    }
  }

  // Grafo de extremos: cada nodo es una posición, cada arista una curva.
  const chainable = curves.filter((c) => endpoints(c) !== null);
  const nodes = new Map<string, SolvedCurve[]>();
  for (const c of chainable) {
    for (const p of endpoints(c)!) {
      const k = key(p);
      if (!nodes.has(k)) nodes.set(k, []);
      nodes.get(k)!.push(c);
    }
  }

  const used = new Set<string>();
  for (const seed of chainable) {
    if (used.has(seed.id)) continue;

    const segments: LoopSegment[] = [];
    let current = seed;
    let [, head] = endpoints(seed)!;
    used.add(seed.id);
    segments.push({ curve: seed, reversed: false });
    const startKey = key(endpoints(seed)![0]);

    while (key(head) !== startKey) {
      const next = (nodes.get(key(head)) ?? []).find(
        (c) => c.id !== current.id && !used.has(c.id),
      );
      if (!next) break; // cadena abierta: no sirve para extruir
      const [na, nb] = endpoints(next)!;
      const reversed = key(nb) === key(head);
      head = reversed ? na : nb;
      used.add(next.id);
      segments.push({ curve: next, reversed });
      current = next;
    }

    if (key(head) === startKey && segments.length > 1) close(segments);
  }

  return loops;
}

export interface Region {
  outer: Loop;
  holes: Loop[];
}

export interface IndexedRegion extends Region {
  /** Índice estable, para que un feature pueda referirse a este perfil. */
  index: number;
  /** Área neta, descontando los agujeros. */
  area: number;
  centroid: P2;
}

function centroidOf(poly: P2[]): P2 {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) < 1e-12) {
    // Degenerado: promedio simple.
    return {
      x: poly.reduce((s2, p) => s2 + p.x, 0) / poly.length,
      y: poly.reduce((s2, p) => s2 + p.y, 0) / poly.length,
    };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/**
 * Perfiles del boceto con un índice estable.
 *
 * El orden sale del centroide, no del orden en que se dibujó: así, al agregar
 * geometría en otra parte del boceto, un feature que apuntaba al perfil 2 sigue
 * apuntando al mismo.
 */
export function orderedRegions(curves: SolvedCurve[]): IndexedRegion[] {
  const r = (n: number) => Math.round(n * 1e4);
  return findRegions(findLoops(curves))
    .map((region) => {
      const centroid = centroidOf(region.outer.polyline);
      const area = Math.abs(region.outer.signedArea)
        - region.holes.reduce((s2, h) => s2 + Math.abs(h.signedArea), 0);
      return { ...region, centroid, area, index: 0 };
    })
    .sort((a, b) =>
      r(a.centroid.x) - r(b.centroid.x) || r(a.centroid.y) - r(b.centroid.y))
    .map((region, index) => ({ ...region, index }));
}

/** Separa contornos de agujeros por contención. */
export function findRegions(loops: Loop[]): Region[] {
  const depth = loops.map((l) =>
    loops.filter((o) => o !== l && pointInPolygon(l.polyline[0], o.polyline)).length);

  // Profundidad par = contorno; impar = agujero del contorno que lo contiene.
  const regions: Region[] = [];
  loops.forEach((l, i) => { if (depth[i] % 2 === 0) regions.push({ outer: l, holes: [] }); });

  loops.forEach((l, i) => {
    if (depth[i] % 2 === 0) return;
    // El contorno más chico que lo contiene es su dueño.
    const owner = regions
      .filter((r) => pointInPolygon(l.polyline[0], r.outer.polyline))
      .sort((a, b) => Math.abs(a.outer.signedArea) - Math.abs(b.outer.signedArea))[0];
    owner?.holes.push(l);
  });

  return regions;
}
