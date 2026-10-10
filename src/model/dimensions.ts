/**
 * Cotas del boceto.
 *
 * Una cota es una restricción de PlaneGCS con un número adentro. Acá se extrae
 * lo necesario para dibujarla y para editar su valor: sin eso, aplicar una cota
 * es escribir un número que después no se ve ni se puede corregir.
 */
import type { P2, SolvedSketch } from '../kernel/sketch';
import type { Prim, XY } from './sketchEdit';
import type { SketchItem } from './types';

export type DimensionKind = 'distance' | 'radius' | 'diameter' | 'angle';

export interface Dimension {
  /** Id de la restricción. */
  id: string;
  kind: DimensionKind;
  value: number;
  text: string;
  /** Extremos que la cota mide (en un radio, centro y punto del borde). */
  a: P2;
  b: P2;
  /** Vértice del ángulo, sólo en las angulares. */
  vertex?: P2;
  /** Corrimiento del texto respecto de su posición por defecto, en mm. */
  offset: XY;
}

/** Campo numérico de cada tipo de cota. */
const VALUE_FIELD: Record<string, { field: string; kind: DimensionKind }> = {
  p2p_distance: { field: 'distance', kind: 'distance' },
  p2l_distance: { field: 'distance', kind: 'distance' },
  circle_radius: { field: 'radius', kind: 'radius' },
  arc_radius: { field: 'radius', kind: 'radius' },
  circle_diameter: { field: 'diameter', kind: 'diameter' },
  arc_diameter: { field: 'diameter', kind: 'diameter' },
  l2l_angle_ll: { field: 'angle', kind: 'angle' },
};

export const isDimension = (prim: SketchItem): boolean =>
  VALUE_FIELD[(prim as Prim).type as string] !== undefined;

/** Valor numérico de una cota, o null si está atada a un parámetro con nombre. */
export function dimensionValue(prim: SketchItem): number | null {
  const spec = VALUE_FIELD[(prim as Prim).type as string];
  if (!spec) return null;
  const raw = (prim as Prim)[spec.field];
  return typeof raw === 'number' ? raw : null;
}

/** Cambia el valor de una cota. */
export function setDimensionValue(
  primitives: SketchItem[], id: string, value: number,
): SketchItem[] {
  return primitives.map((p) => {
    const prim = p as Prim;
    if (prim.id !== id) return p;
    const spec = VALUE_FIELD[prim.type as string];
    return spec ? ({ ...prim, [spec.field]: value } as SketchItem) : p;
  });
}



const sub = (a: P2, b: P2): P2 => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v: P2) => Math.hypot(v.x, v.y);

/** Punto más cercano del segmento infinito que pasa por `a` y `b`. */
function projectOnLine(p: P2, a: P2, b: P2): P2 {
  const d = sub(b, a);
  const l2 = d.x * d.x + d.y * d.y;
  if (l2 === 0) return a;
  const t = ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / l2;
  return { x: a.x + t * d.x, y: a.y + t * d.y };
}

function lineEnds(solved: SolvedSketch, id: string): [P2, P2] | null {
  const c = solved.curves.find((x) => x.id === id);
  return c?.kind === 'line' ? [c.a, c.b] : null;
}

/** Intersección de dos rectas infinitas, o null si son paralelas. */
function lineIntersection(a1: P2, a2: P2, b1: P2, b2: P2): P2 | null {
  const r = sub(a2, a1), s = sub(b2, b1);
  const cross = r.x * s.y - r.y * s.x;
  if (Math.abs(cross) < 1e-9) return null;
  const t = ((b1.x - a1.x) * s.y - (b1.y - a1.y) * s.x) / cross;
  return { x: a1.x + t * r.x, y: a1.y + t * r.y };
}

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** Texto de una cota con el prefijo que corresponde en un plano. */
export function dimensionText(kind: DimensionKind, value: number): string {
  switch (kind) {
    case 'diameter': return `\u00d8${num(value)}`;
    case 'radius': return `R${num(value)}`;
    case 'angle': return `${num((value * 180) / Math.PI)}\u00b0`;
    default: return num(value);
  }
}

/**
 * Cotas listas para dibujar.
 *
 * Las que no se pueden ubicar (porque su geometría ya no está, o porque el
 * valor es un parámetro con nombre) se omiten en vez de romper el dibujo.
 */
export function collectDimensions(
  primitives: SketchItem[], solved: SolvedSketch,
  labelOffsets: Record<string, [number, number]> = {},
): Dimension[] {
  const out: Dimension[] = [];
  const point = (id: string) => solved.points.get(id);

  for (const item of primitives) {
    const prim = item as Prim;
    const spec = VALUE_FIELD[prim.type as string];
    if (!spec) continue;
    const value = dimensionValue(item);
    if (value === null) continue;

    const id = prim.id as string;
    const saved = labelOffsets[id];
    const offset: XY = saved ? { x: saved[0], y: saved[1] } : { x: 0, y: 0 };

    switch (prim.type) {
      case 'p2p_distance': {
        const a = point(prim.p1_id as string);
        const b = point(prim.p2_id as string);
        if (a && b) {
          out.push({ id, kind: 'distance', value, text: dimensionText('distance', value), a, b, offset });
        }
        break;
      }

      case 'p2l_distance': {
        const p = point(prim.p_id as string);
        const ends = lineEnds(solved, prim.l_id as string);
        if (p && ends) {
          out.push({
            id, kind: 'distance', value, text: dimensionText('distance', value),
            a: p, b: projectOnLine(p, ends[0], ends[1]), offset,
          });
        }
        break;
      }

      case 'circle_radius':
      case 'arc_radius':
      case 'circle_diameter':
      case 'arc_diameter': {
        const curveId = (prim.c_id ?? prim.a_id) as string;
        const c = solved.curves.find((x) => x.id === curveId);
        if (!c || c.kind === 'line' || c.kind === 'spline') break;
        const isDiameter = spec.kind === 'diameter';
        // La línea de cota sale del centro hacia arriba y a la derecha.
        const dir = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
        out.push({
          id, kind: spec.kind, value,
          text: dimensionText(spec.kind, value),
          a: isDiameter
            ? { x: c.c.x - dir.x * c.r, y: c.c.y - dir.y * c.r }
            : c.c,
          b: { x: c.c.x + dir.x * c.r, y: c.c.y + dir.y * c.r },
          offset,
        });
        break;
      }

      case 'l2l_angle_ll': {
        const l1 = lineEnds(solved, prim.l1_id as string);
        const l2 = lineEnds(solved, prim.l2_id as string);
        if (!l1 || !l2) break;
        const vertex = lineIntersection(l1[0], l1[1], l2[0], l2[1]);
        if (!vertex) break;
        // Se apunta hacia el extremo más lejano de cada línea, que es el que
        // el usuario está mirando.
        const far = (ends: [P2, P2]) =>
          len(sub(ends[0], vertex)) > len(sub(ends[1], vertex)) ? ends[0] : ends[1];
        out.push({
          id, kind: 'angle', value, text: dimensionText('angle', value),
          a: far(l1), b: far(l2), vertex, offset,
        });
        break;
      }
    }
  }

  return out;
}

/** Valor que conviene proponer al crear la cota, leído de la geometría actual. */
export function suggestedValue(
  kind: DimensionKind, ids: string[], solved: SolvedSketch,
): number | null {
  if (kind === 'radius' || kind === 'diameter') {
    const c = solved.curves.find((x) => x.id === ids[0]);
    if (c && c.kind !== 'line' && c.kind !== 'spline') {
      return kind === 'diameter' ? c.r * 2 : c.r;
    }
    return null;
  }

  if (kind === 'angle') {
    const l1 = lineEnds(solved, ids[0]);
    const l2 = lineEnds(solved, ids[1]);
    if (!l1 || !l2) return null;
    const ang = (e: [P2, P2]) => Math.atan2(e[1].y - e[0].y, e[1].x - e[0].x);
    let d = ang(l2) - ang(l1);
    while (d <= -Math.PI) d += 2 * Math.PI;
    while (d > Math.PI) d -= 2 * Math.PI;
    return Math.abs(d);
  }

  // Distancia: entre dos puntos, el largo de una línea, o punto a línea.
  if (ids.length === 2) {
    const a = solved.points.get(ids[0]);
    const b = solved.points.get(ids[1]);
    if (a && b) return len(sub(b, a));

    const p = solved.points.get(ids[0]) ?? solved.points.get(ids[1]);
    const lineId = solved.points.has(ids[0]) ? ids[1] : ids[0];
    const ends = lineEnds(solved, lineId);
    if (p && ends) return len(sub(p, projectOnLine(p, ends[0], ends[1])));
  }

  const line = lineEnds(solved, ids[0]);
  return line ? len(sub(line[1], line[0])) : null;
}

// --------------------------------------------------------------------------
// Herramienta de cota
// --------------------------------------------------------------------------

export interface InferredDimension {
  kind: DimensionKind;
  /** Ids en el orden que espera `applyConstraint`. */
  ids: string[];
  /** Valor actual de la geometría, para proponerlo. */
  value: number;
  /** Punto respecto del cual se mide el corrimiento de la etiqueta. */
  anchor: P2;
  /** Extremos de la cota, para dibujarla antes de confirmarla. */
  a: P2;
  b: P2;
  vertex?: P2;
}

/** Convierte una cota inferida en algo que se pueda dibujar ya mismo. */
export function previewDimension(dim: InferredDimension, label: P2): Dimension {
  return {
    id: '__preview__',
    kind: dim.kind,
    value: dim.value,
    text: dimensionText(dim.kind, dim.value),
    a: dim.a,
    b: dim.b,
    vertex: dim.vertex,
    offset: { x: label.x - dim.anchor.x, y: label.y - dim.anchor.y },
  };
}

export type InferResult =
  | { status: 'need-more'; hint: string }
  | { status: 'ok'; dim: InferredDimension }
  | { status: 'invalid'; message: string };

const typeOf = (primitives: SketchItem[], id: string): string | undefined =>
  primitives.find((p) => (p as Prim).id === id) !== undefined
    ? ((primitives.find((p) => (p as Prim).id === id) as Prim).type as string)
    : undefined;

const mid = (a: P2, b: P2): P2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Qué cota corresponde a lo que se eligió.
 *
 * Una sola herramienta que mira los tipos y decide: el largo de una línea, el
 * diámetro de un círculo, el ángulo entre dos líneas, la distancia entre dos
 * puntos o de un punto a una línea. Es como funciona la cota en cualquier CAD
 * y evita tener un botón por cada caso.
 */
export function inferDimension(
  primitives: SketchItem[], solved: SolvedSketch, picks: string[],
): InferResult {
  if (picks.length === 0) {
    return { status: 'need-more', hint: 'Elegí una línea, un círculo, un arco o dos puntos' };
  }

  const types = picks.map((id) => typeOf(primitives, id));
  if (types.some((t) => t === undefined)) {
    return { status: 'invalid', message: 'Esa geometría ya no existe' };
  }
  if (types.includes('spline')) {
    return { status: 'invalid', message: 'Todavía no se puede acotar una curva por puntos' };
  }

  const curve = (id: string) => solved.curves.find((c) => c.id === id);
  const value = (kind: DimensionKind, ids: string[]) => suggestedValue(kind, ids, solved);

  // --- Un solo elemento ---
  if (picks.length === 1) {
    const [id] = picks;
    const t = types[0];

    if (t === 'line') {
      const c = curve(id);
      if (c?.kind !== 'line') return { status: 'invalid', message: 'No encuentro esa línea' };
      const v = value('distance', [id]);
      if (v === null) return { status: 'invalid', message: 'No pude medir esa línea' };
      return {
        status: 'ok',
        dim: { kind: 'distance', ids: [id], value: v, anchor: mid(c.a, c.b), a: c.a, b: c.b },
      };
    }

    if (t === 'circle' || t === 'arc') {
      // Convención de CAD: el círculo se acota por diámetro y el arco por radio.
      const kind: DimensionKind = t === 'circle' ? 'diameter' : 'radius';
      const c = curve(id);
      if (!c || c.kind === 'line' || c.kind === 'spline') {
        return { status: 'invalid', message: 'No encuentro esa curva' };
      }
      const v = value(kind, [id]);
      if (v === null) return { status: 'invalid', message: 'No pude medir esa curva' };
      // El radio sale del centro; el diámetro cruza de lado a lado.
      const dir = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
      return {
        status: 'ok',
        dim: {
          kind, ids: [id], value: v, anchor: c.c,
          a: kind === 'diameter' ? { x: c.c.x - dir.x * c.r, y: c.c.y - dir.y * c.r } : c.c,
          b: { x: c.c.x + dir.x * c.r, y: c.c.y + dir.y * c.r },
        },
      };
    }

    return { status: 'need-more', hint: 'Elegí otro punto o una línea para medir contra él' };
  }

  // --- Dos elementos ---
  const [a, b] = picks;
  const [ta, tb] = types;

  if (ta === 'point' && tb === 'point') {
    const pa = solved.points.get(a), pb = solved.points.get(b);
    if (!pa || !pb) return { status: 'invalid', message: 'No encuentro esos puntos' };
    return {
      status: 'ok',
      dim: {
        kind: 'distance', ids: [a, b],
        value: Math.hypot(pb.x - pa.x, pb.y - pa.y),
        anchor: mid(pa, pb), a: pa, b: pb,
      },
    };
  }

  if ((ta === 'point' && tb === 'line') || (ta === 'line' && tb === 'point')) {
    const pointId = ta === 'point' ? a : b;
    const lineId = ta === 'point' ? b : a;
    const p = solved.points.get(pointId);
    const ends = lineEnds(solved, lineId);
    const v = value('distance', [pointId, lineId]);
    if (!p || !ends || v === null) {
      return { status: 'invalid', message: 'No pude medir esa distancia' };
    }
    const foot = projectOnLine(p, ends[0], ends[1]);
    return {
      status: 'ok',
      dim: { kind: 'distance', ids: [pointId, lineId], value: v, anchor: p, a: p, b: foot },
    };
  }

  if (ta === 'line' && tb === 'line') {
    const ca = curve(a), cb = curve(b);
    if (ca?.kind !== 'line' || cb?.kind !== 'line') {
      return { status: 'invalid', message: 'No encuentro esas líneas' };
    }
    const da = { x: ca.b.x - ca.a.x, y: ca.b.y - ca.a.y };
    const db = { x: cb.b.x - cb.a.x, y: cb.b.y - cb.a.y };
    const cross = da.x * db.y - da.y * db.x;
    const parallel = Math.abs(cross) < 1e-6 * Math.hypot(da.x, da.y) * Math.hypot(db.x, db.y);

    if (parallel) {
      // Entre paralelas el ángulo no dice nada: se mide la separación, que en
      // PlaneGCS se expresa como la distancia de un extremo de una a la otra.
      const endpoint = (primitives.find((p) => (p as Prim).id === a) as Prim).p1_id as string;
      const p = solved.points.get(endpoint);
      if (!p) return { status: 'invalid', message: 'No encuentro el extremo de esa línea' };
      const dist = Math.abs(
        ((p.y - cb.a.y) * db.x - (p.x - cb.a.x) * db.y) / (Math.hypot(db.x, db.y) || 1),
      );
      const foot = projectOnLine(p, cb.a, cb.b);
      return {
        status: 'ok',
        dim: {
          kind: 'distance', ids: [endpoint, b], value: dist,
          anchor: mid(ca.a, cb.a), a: p, b: foot,
        },
      };
    }

    const v = value('angle', [a, b]);
    if (v === null) return { status: 'invalid', message: 'No pude medir ese ángulo' };
    // El ancla tiene que ser el vértice: es desde donde se mide el corrimiento
    // de la etiqueta al dibujarla.
    const vertex = lineIntersection(ca.a, ca.b, cb.a, cb.b);
    if (!vertex) return { status: 'invalid', message: 'Esas líneas no se cortan' };
    const far = (ends: [P2, P2]) =>
      Math.hypot(ends[0].x - vertex.x, ends[0].y - vertex.y)
        > Math.hypot(ends[1].x - vertex.x, ends[1].y - vertex.y) ? ends[0] : ends[1];
    return {
      status: 'ok',
      dim: {
        kind: 'angle', ids: [a, b], value: v, anchor: vertex,
        a: far([ca.a, ca.b]), b: far([cb.a, cb.b]), vertex,
      },
    };
  }

  return { status: 'invalid', message: 'No sé qué medir entre esos dos elementos' };
}
