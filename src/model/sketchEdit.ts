/**
 * Edición de la geometría de un boceto.
 *
 * Trabaja sobre el array de primitivas de PlaneGCS. Funciones puras: reciben
 * las primitivas y devuelven unas nuevas, para que el undo siga siendo gratis.
 */
import type { SketchItem } from './types';

export type Prim = SketchItem & Record<string, unknown>;

export interface XY { x: number; y: number }

/** Id único dentro del boceto, con prefijo por tipo para poder leerlo. */
export function freshId(primitives: SketchItem[], prefix: string): string {
  const used = new Set(primitives.map((p) => (p as Prim).id as string));
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export const getPoints = (primitives: SketchItem[]) =>
  primitives.filter((p) => (p as Prim).type === 'point') as (Prim & { x: number; y: number; id: string })[];

export const findPrim = (primitives: SketchItem[], id: string) =>
  primitives.find((p) => (p as Prim).id === id) as Prim | undefined;

export const primType = (primitives: SketchItem[], id: string) =>
  findPrim(primitives, id)?.type as string | undefined;

/**
 * Punto existente más cercano dentro del radio, para encadenar geometría.
 *
 * `solvedPositions` es dónde quedaron los puntos después de resolver, que es
 * donde el usuario los ve. Las coordenadas guardadas en la primitiva son sólo
 * la semilla del solver: en cuanto hay restricciones dejan de coincidir, y
 * buscar contra ellas haría que los puntos no se puedan agarrar.
 */
export function snapPoint(
  primitives: SketchItem[], at: XY, radius: number,
  solvedPositions?: Map<string, XY>,
): string | null {
  let best: string | null = null;
  let bestD = radius;
  for (const p of getPoints(primitives)) {
    const pos = solvedPositions?.get(p.id) ?? p;
    const d = Math.hypot(pos.x - at.x, pos.y - at.y);
    if (d <= bestD) { bestD = d; best = p.id; }
  }
  return best;
}

/**
 * Dónde va a caer el próximo clic.
 *
 * El editor lo calcula mientras se mueve el mouse y lo dibuja, así se ve de
 * antemano si el clic va a cerrar el perfil o a quedar suelto.
 */
export interface SnapTarget {
  at: XY;
  /** Punto existente que se va a reutilizar (coincidencia implícita). */
  pointId?: string;
  /** Curva sobre la que cae: el punto nuevo queda restringido a ella. */
  curveId?: string;
  curveType?: 'line' | 'circle' | 'arc';
  /**
   * Cayó sobre un vértice de la cuadrícula. Es sólo ayuda para dibujar: la
   * cuadrícula depende del zoom, así que atar el punto a ella con una
   * restricción sería atarlo a algo que cambia solo.
   */
  onGrid?: boolean;
}

export const freeSnap = (at: XY): SnapTarget => ({ at });

const ON_CURVE: Record<string, { type: string; key: string }> = {
  line: { type: 'point_on_line_pl', key: 'l_id' },
  circle: { type: 'point_on_circle', key: 'c_id' },
  arc: { type: 'point_on_arc', key: 'a_id' },
};

/**
 * Crea un punto en el destino del enganche, o devuelve el id del que ya estaba.
 * Si cae sobre una curva, deja puesta la restricción correspondiente.
 */
export function ensurePoint(
  primitives: SketchItem[], snap: SnapTarget, snapRadius: number,
): { primitives: SketchItem[]; id: string } {
  const existing = snap.pointId ?? snapPoint(primitives, snap.at, snapRadius);
  if (existing) return { primitives, id: existing };

  const id = freshId(primitives, 'p');
  let out: SketchItem[] = [
    ...primitives,
    { id, type: 'point', x: snap.at.x, y: snap.at.y, fixed: false },
  ];

  const rule = snap.curveId && snap.curveType ? ON_CURVE[snap.curveType] : undefined;
  if (rule && snap.curveId) {
    out = [...out, {
      id: freshId(out, 'c'), type: rule.type, p_id: id, [rule.key]: snap.curveId,
    } as unknown as SketchItem];
  }
  return { primitives: out, id };
}

export function addLine(
  primitives: SketchItem[], a: SnapTarget, b: SnapTarget, snapRadius: number,
): SketchItem[] {
  const s1 = ensurePoint(primitives, a, snapRadius);
  const s2 = ensurePoint(s1.primitives, b, snapRadius);
  if (s1.id === s2.id) return primitives; // línea de longitud cero
  return [...s2.primitives, {
    id: freshId(s2.primitives, 'l'), type: 'line', p1_id: s1.id, p2_id: s2.id,
  }];
}

/** Rectángulo con las restricciones horizontal/vertical ya puestas. */
export function addRectangle(
  primitives: SketchItem[], a: XY, b: XY,
): SketchItem[] {
  if (Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.y - b.y) < 1e-9) return primitives;
  let out = [...primitives];
  const corners: XY[] = [
    { x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y },
  ];
  const ids = corners.map((c) => {
    const id = freshId(out, 'p');
    out = [...out, { id, type: 'point', x: c.x, y: c.y, fixed: false }];
    return id;
  });
  const lines = ids.map((id, i) => {
    const lid = freshId(out, 'l');
    out = [...out, { id: lid, type: 'line', p1_id: id, p2_id: ids[(i + 1) % 4] }];
    return lid;
  });
  // Sin esto el "rectángulo" es un cuadrilátero cualquiera en cuanto se arrastre.
  lines.forEach((lid, i) => {
    const cid = freshId(out, 'c');
    out = [...out, { id: cid, type: i % 2 === 0 ? 'horizontal_l' : 'vertical_l', l_id: lid }];
  });
  return out;
}

export function addCircle(
  primitives: SketchItem[], center: SnapTarget, radius: number, snapRadius: number,
): SketchItem[] {
  if (radius <= 1e-6) return primitives;
  const c = ensurePoint(primitives, center, snapRadius);
  return [...c.primitives, {
    id: freshId(c.primitives, 'ci'), type: 'circle', c_id: c.id, radius,
  }];
}

/** Arco por centro, punto inicial y punto final (el radio lo fija el inicial). */
export function addArc(
  primitives: SketchItem[], centerSnap: SnapTarget, startSnap: SnapTarget, end: XY,
  snapRadius: number,
): SketchItem[] {
  const center = centerSnap.at, start = startSnap.at;
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  if (radius <= 1e-6) return primitives;

  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(end.y - center.y, end.x - center.x);

  const c = ensurePoint(primitives, centerSnap, snapRadius);
  const s = ensurePoint(c.primitives, startSnap, snapRadius);
  // El extremo se lleva al radio del arco, no donde cayó el clic.
  const e = ensurePoint(s.primitives, freeSnap({
    x: center.x + radius * Math.cos(a1), y: center.y + radius * Math.sin(a1),
  }), snapRadius);

  return [...e.primitives, {
    id: freshId(e.primitives, 'a'), type: 'arc',
    c_id: c.id, radius, start_id: s.id, end_id: e.id, start_angle: a0, end_angle: a1,
  }];
}

/**
 * Curva por puntos. Cada clic es un punto real del boceto, así que después se
 * puede arrastrar, acotar o restringir como cualquier otro.
 */
export function addSpline(
  primitives: SketchItem[], pts: SnapTarget[], snapRadius: number, periodic = false,
): SketchItem[] {
  if (pts.length < 2) return primitives;
  let out = primitives;
  const ids: string[] = [];
  for (const p of pts) {
    const r = ensurePoint(out, p, snapRadius);
    out = r.primitives;
    // Un punto repetido seguido rompería la interpolación.
    if (ids[ids.length - 1] !== r.id) ids.push(r.id);
  }
  if (ids.length < 2) return primitives;
  return [...out, {
    id: freshId(out, 'sp'), type: 'spline', point_ids: ids, periodic,
  } as SketchItem];
}

// --------------------------------------------------------------------------
// Restricciones
// --------------------------------------------------------------------------

export type ConstraintKind =
  | 'horizontal' | 'vertical' | 'coincident' | 'parallel' | 'perpendicular'
  | 'equal' | 'tangent' | 'symmetric' | 'concentric' | 'collinear' | 'fix'
  | 'midpoint' | 'distance' | 'radius' | 'diameter' | 'angle';

export interface ConstraintSpec {
  kind: ConstraintKind;
  label: string;
  /** Qué tiene que haber seleccionado para que la restricción tenga sentido. */
  accepts: (types: string[]) => boolean;
}

const only = (...want: string[]) => (types: string[]) =>
  types.length === want.length && want.every((w, i) => types[i] === w);

const allOf = (type: string, min: number, max = min) => (types: string[]) =>
  types.length >= min && types.length <= max && types.every((t) => t === type);

export const CONSTRAINTS: ConstraintSpec[] = [
  { kind: 'horizontal', label: 'Horizontal', accepts: allOf('line', 1, 9) },
  { kind: 'vertical', label: 'Vertical', accepts: allOf('line', 1, 9) },
  { kind: 'coincident', label: 'Coincidente', accepts: allOf('point', 2) },
  { kind: 'parallel', label: 'Paralela', accepts: allOf('line', 2) },
  { kind: 'perpendicular', label: 'Perpendicular', accepts: allOf('line', 2) },
  { kind: 'collinear', label: 'Colineal', accepts: allOf('line', 2) },
  { kind: 'equal', label: 'Igual', accepts: (t) => t.length === 2 && t[0] === t[1] },
  { kind: 'tangent', label: 'Tangente', accepts: (t) => t.length === 2 && t.includes('line') },
  { kind: 'symmetric', label: 'Simetría', accepts: only('point', 'point', 'line') },
  { kind: 'concentric', label: 'Concéntrica', accepts: (t) => t.length === 2 && !t.includes('line') && !t.includes('point') },
  { kind: 'midpoint', label: 'Punto medio', accepts: only('point', 'line') },
  { kind: 'fix', label: 'Fijar', accepts: allOf('point', 1, 9) },
];

/**
 * Las cotas (distancia, ángulo, radio, diámetro) no están en esta lista: las
 * crea la herramienta de cota, que infiere cuál corresponde según lo elegido.
 * `applyConstraint` sí las sabe aplicar.
 */

/** Extremos de una línea o arco, para traducir una selección de curva a puntos. */
function endpointsOf(prim: Prim): [string, string] | null {
  if (prim.type === 'line') return [prim.p1_id as string, prim.p2_id as string];
  if (prim.type === 'arc') return [prim.start_id as string, prim.end_id as string];
  return null;
}

export interface ApplyResult {
  primitives: SketchItem[];
  error?: string;
}

/**
 * Aplica una restricción a la selección. `value` sólo se usa en las que llevan
 * número (cota y radio).
 */
export function applyConstraint(
  primitives: SketchItem[], kind: ConstraintKind, selection: string[], value?: number,
): ApplyResult {
  const prims = selection.map((id) => findPrim(primitives, id));
  if (prims.some((p) => !p)) return { primitives, error: 'La selección ya no existe' };
  const items = prims as Prim[];
  const types = items.map((p) => p.type as string);
  const add = (c: Record<string, unknown>) => ({
    primitives: [...primitives, { id: freshId(primitives, 'c'), ...c } as SketchItem],
  });

  switch (kind) {
    case 'horizontal':
    case 'vertical': {
      const type = kind === 'horizontal' ? 'horizontal_l' : 'vertical_l';
      let out = primitives;
      for (const item of items) {
        out = [...out, { id: freshId(out, 'c'), type, l_id: item.id } as SketchItem];
      }
      return { primitives: out };
    }

    case 'coincident':
      return add({ type: 'p2p_coincident', p1_id: items[0].id, p2_id: items[1].id });

    case 'parallel':
      return add({ type: 'parallel', l1_id: items[0].id, l2_id: items[1].id });

    case 'perpendicular':
      return add({ type: 'perpendicular_ll', l1_id: items[0].id, l2_id: items[1].id });

    case 'collinear': {
      // Colineal = los dos extremos de una línea están sobre la otra. PlaneGCS
      // no tiene una restricción propia para esto, pero el par lo expresa
      // exactamente y deja la segunda línea sobre la recta de la primera.
      const ends = endpointsOf(items[1]);
      if (!ends) return { primitives, error: 'Elegí dos líneas' };
      let out = primitives;
      for (const p of ends) {
        out = [...out, {
          id: freshId(out, 'c'), type: 'point_on_line_pl', p_id: p, l_id: items[0].id,
        } as unknown as SketchItem];
      }
      return { primitives: out };
    }

    case 'equal': {
      if (types[0] === 'line') {
        return add({ type: 'equal_length', l1_id: items[0].id, l2_id: items[1].id });
      }
      if (types[0] === 'circle') {
        return add({ type: 'equal_radius_cc', c1_id: items[0].id, c2_id: items[1].id });
      }
      if (types[0] === 'arc') {
        return add({ type: 'equal_radius_aa', a1_id: items[0].id, a2_id: items[1].id });
      }
      return { primitives, error: 'Igualdad no soportada para esa selección' };
    }

    case 'tangent': {
      const line = items.find((p) => p.type === 'line');
      const other = items.find((p) => p.type !== 'line');
      if (!line || !other) return { primitives, error: 'Elegí una línea y un círculo o arco' };
      return add({
        type: other.type === 'arc' ? 'tangent_la' : 'tangent_lc',
        l_id: line.id, ...(other.type === 'arc' ? { a_id: other.id } : { c_id: other.id }),
      });
    }

    case 'symmetric':
      return add({
        type: 'p2p_symmetric_ppl',
        p1_id: items[0].id, p2_id: items[1].id, l_id: items[2].id,
      });

    case 'concentric': {
      // Concéntrico = los centros coinciden.
      const centers = items.map((p) => p.c_id as string);
      if (centers.some((c) => !c)) return { primitives, error: 'Esa geometría no tiene centro' };
      return add({ type: 'p2p_coincident', p1_id: centers[0], p2_id: centers[1] });
    }

    case 'midpoint': {
      const point = items.find((p) => p.type === 'point');
      const line = items.find((p) => p.type === 'line');
      if (!point || !line) return { primitives, error: 'Elegí un punto y una línea' };
      const ends = endpointsOf(line)!;
      // "P es el punto medio de AB" equivale a "A y B son simétricos respecto
      // de P". midpoint_on_line_pppp necesitaría una línea degenerada y el
      // solver no converge con eso.
      return add({
        type: 'p2p_symmetric_ppp',
        p1_id: ends[0], p2_id: ends[1], p_id: point.id,
      });
    }

    case 'fix': {
      // "Fijar" marca los puntos como fijos en vez de agregar restricciones.
      const ids = new Set(items.map((p) => p.id));
      return {
        primitives: primitives.map((p) =>
          ids.has((p as Prim).id) ? { ...p, fixed: !(p as Prim).fixed } as SketchItem : p),
      };
    }

    case 'distance': {
      if (value === undefined) return { primitives, error: 'Falta el valor de la cota' };
      // Punto contra línea: distancia perpendicular, no entre extremos.
      const point = items.find((p) => p.type === 'point');
      const line = items.find((p) => p.type === 'line');
      if (point && line) {
        return add({ type: 'p2l_distance', p_id: point.id, l_id: line.id, distance: value });
      }
      const pts = types[0] === 'line' ? endpointsOf(items[0])! : [items[0].id, items[1].id];
      return add({ type: 'p2p_distance', p1_id: pts[0], p2_id: pts[1], distance: value });
    }

    case 'angle': {
      if (value === undefined) return { primitives, error: 'Falta el ángulo' };
      return add({
        type: 'l2l_angle_ll', l1_id: items[0].id, l2_id: items[1].id,
        angle: (value * Math.PI) / 180,
      });
    }

    case 'radius': {
      if (value === undefined) return { primitives, error: 'Falta el radio' };
      return items[0].type === 'arc'
        ? add({ type: 'arc_radius', a_id: items[0].id, radius: value })
        : add({ type: 'circle_radius', c_id: items[0].id, radius: value });
    }

    case 'diameter': {
      if (value === undefined) return { primitives, error: 'Falta el diámetro' };
      return items[0].type === 'arc'
        ? add({ type: 'arc_diameter', a_id: items[0].id, diameter: value })
        : add({ type: 'circle_diameter', c_id: items[0].id, diameter: value });
    }
  }
}

/**
 * Ids a los que apunta una primitiva. Las claves `*_id` son referencias
 * sueltas y las `*_ids` son listas (los puntos de una curva por puntos).
 */
export function referencedIds(prim: Prim): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(prim)) {
    if (k.endsWith('_ids') && Array.isArray(v)) out.push(...(v as string[]));
    else if (k.endsWith('_id') && typeof v === 'string') out.push(v);
  }
  return out;
}

/**
 * Deja un punto arrastrado enganchado a donde cayó.
 *
 * Arrastrar un punto encima de otro y que queden pegados es la forma más
 * natural de cerrar un contorno; soltar sobre una curva lo deja sobre ella.
 * En los dos casos la unión queda como restricción, no como una casualidad de
 * posición que el próximo arrastre rompería.
 */
export function attachDraggedPoint(
  primitives: SketchItem[], pointId: string, snap: SnapTarget,
): SketchItem[] {
  const already = (type: string, target: string) =>
    primitives.some((p) => {
      const prim = p as Prim;
      return prim.type === type
        && prim.p_id === pointId
        && (prim.l_id === target || prim.c_id === target || prim.a_id === target);
    });

  const target = snap.pointId;
  if (target && target !== pointId) {
    const dup = primitives.some((p) => {
      const prim = p as Prim;
      return prim.type === 'p2p_coincident'
        && [prim.p1_id, prim.p2_id].includes(pointId)
        && [prim.p1_id, prim.p2_id].includes(target);
    });
    if (dup) return primitives;
    return [...primitives, {
      id: freshId(primitives, 'c'), type: 'p2p_coincident',
      p1_id: pointId, p2_id: target,
    } as SketchItem];
  }

  const rule = snap.curveId && snap.curveType ? ON_CURVE[snap.curveType] : undefined;
  if (rule && snap.curveId && !already(rule.type, snap.curveId)) {
    return [...primitives, {
      id: freshId(primitives, 'c'), type: rule.type,
      p_id: pointId, [rule.key]: snap.curveId,
    } as unknown as SketchItem];
  }

  return primitives;
}

/** Mueve un punto (arrastre en el editor). */
export function movePoint(
  primitives: SketchItem[], id: string, to: XY,
): SketchItem[] {
  return primitives.map((p) =>
    (p as Prim).id === id ? { ...p, x: to.x, y: to.y } as SketchItem : p);
}

/**
 * Borra la selección y todo lo que dependía de ella: una línea sin sus puntos,
 * o una restricción sobre geometría borrada, rompe el solver.
 */
/** Tipos que son geometría dibujada (lo demás son puntos y restricciones). */
const GEOMETRY = ['line', 'circle', 'arc', 'spline'];

/**
 * Borra los ids pedidos y todo lo que los referenciaba, SIN limpiar los puntos
 * que queden sueltos.
 *
 * La cascada va en una sola dirección: elimina lo que apunta a algo muerto. Un
 * punto no apunta a su curva, así que esto solo no alcanza para limpiarlo; de
 * eso se encarga `pruneOrphanPoints`. Lo usa el recorte, que necesita quitar la
 * curva vieja y recién después reconstruir los pedazos reutilizando sus puntos.
 */
export function cascadeDelete(primitives: SketchItem[], ids: string[]): SketchItem[] {
  const dead = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of primitives) {
      const prim = p as Prim;
      if (dead.has(prim.id as string)) continue;
      if (referencedIds(prim).some((r) => dead.has(r))) {
        dead.add(prim.id as string);
        changed = true;
      }
    }
  }
  return primitives.filter((p) => !dead.has((p as Prim).id as string));
}

/** Puntos que ya no sostienen ninguna geometría. */
export function orphanPoints(primitives: SketchItem[]): string[] {
  const used = new Set<string>();
  for (const p of primitives) {
    const prim = p as Prim;
    if (GEOMETRY.includes(prim.type as string)) {
      for (const id of referencedIds(prim)) used.add(id);
    }
  }
  return primitives
    .filter((p) => (p as Prim).type === 'point' && !used.has((p as Prim).id as string))
    .map((p) => (p as Prim).id as string);
}

/**
 * Saca los puntos que quedaron sueltos al borrar la geometría que los usaba.
 *
 * Todo punto existe porque alguna curva lo necesita: cuando esa curva se va, el
 * punto no aporta nada y sólo ensucia el boceto. Se borra en cascada, así se
 * llevan también las cotas o restricciones que lo mencionaban.
 */
export function pruneOrphanPoints(primitives: SketchItem[]): SketchItem[] {
  let out = primitives;
  for (;;) {
    const orphans = orphanPoints(out);
    if (orphans.length === 0) return out;
    out = cascadeDelete(out, orphans);
  }
}

export function deletePrimitives(
  primitives: SketchItem[], ids: string[],
): SketchItem[] {
  return pruneOrphanPoints(cascadeDelete(primitives, ids));
}

// --------------------------------------------------------------------------
// Herramientas de modificación
// --------------------------------------------------------------------------

/** Qué puntos y curvas tocar: lo seleccionado, o todo si no hay selección. */
function resolveTargets(
  primitives: SketchItem[], selection: string[],
): { points: Set<string>; curves: Prim[] } {
  const all = primitives.map((p) => p as Prim);
  const curves = all.filter((p) => ['line', 'circle', 'arc', 'spline'].includes(p.type as string));
  const chosen = selection.length
    ? curves.filter((c) => selection.includes(c.id as string))
    : curves;

  const points = new Set<string>();
  for (const c of chosen) for (const id of referencedIds(c)) points.add(id);
  // Un punto suelto también puede estar seleccionado.
  for (const id of selection) {
    if (all.find((p) => p.id === id && p.type === 'point')) points.add(id);
  }
  return { points, curves: chosen };
}

/**
 * Copia geometría aplicándole una transformación.
 *
 * Es la base de simetría y de los dos patrones: lo único que cambia entre ellos
 * es la función que mueve cada punto.
 */
function cloneGeometry(
  primitives: SketchItem[], selection: string[],
  transform: (p: XY) => XY,
  /** Los arcos invierten su sentido si la transformación es un espejo. */
  mirrored = false,
): { primitives: SketchItem[]; pointMap: Map<string, string> } {
  const { points, curves } = resolveTargets(primitives, selection);
  let out = [...primitives];
  const pointMap = new Map<string, string>();

  for (const id of points) {
    const src = findPrim(out, id);
    if (!src) continue;
    const at = transform({ x: src.x as number, y: src.y as number });
    const nid = freshId(out, 'p');
    out = [...out, { id: nid, type: 'point', x: at.x, y: at.y, fixed: false }];
    pointMap.set(id, nid);
  }

  for (const c of curves) {
    const map = (id: string) => pointMap.get(id) ?? id;
    if (c.type === 'line') {
      out = [...out, {
        id: freshId(out, 'l'), type: 'line',
        p1_id: map(c.p1_id as string), p2_id: map(c.p2_id as string),
      } as SketchItem];
    } else if (c.type === 'circle') {
      out = [...out, {
        id: freshId(out, 'ci'), type: 'circle',
        c_id: map(c.c_id as string), radius: c.radius as number,
      } as SketchItem];
    } else if (c.type === 'spline') {
      out = [...out, {
        id: freshId(out, 'sp'), type: 'spline',
        point_ids: (c.point_ids as string[]).map(map),
        periodic: c.periodic as boolean,
      } as SketchItem];
    } else if (c.type === 'arc') {
      const center = findPrim(out, map(c.c_id as string))!;
      const start = findPrim(out, map(c.start_id as string))!;
      const end = findPrim(out, map(c.end_id as string))!;
      const ang = (p: Prim) =>
        Math.atan2((p.y as number) - (center.y as number), (p.x as number) - (center.x as number));
      // Al espejar, el arco que iba de A a B ahora va de B a A.
      const [s, e] = mirrored ? [end, start] : [start, end];
      out = [...out, {
        id: freshId(out, 'a'), type: 'arc',
        c_id: center.id, radius: c.radius as number,
        start_id: s.id, end_id: e.id,
        start_angle: ang(s), end_angle: ang(e),
      } as SketchItem];
    }
  }

  return { primitives: out, pointMap };
}

/**
 * Simetría respecto de una línea del boceto.
 *
 * Además de copiar, deja puestas las restricciones de simetría: así, si después
 * movés el original, la copia lo sigue. Eso es lo que la hace útil de verdad.
 */
export function mirror(
  primitives: SketchItem[], selection: string[], axisLineId: string,
): ApplyResult {
  const axis = findPrim(primitives, axisLineId);
  if (!axis || axis.type !== 'line') return { primitives, error: 'Elegí una línea como eje' };

  const a = findPrim(primitives, axis.p1_id as string)!;
  const b = findPrim(primitives, axis.p2_id as string)!;
  const ax = a.x as number, ay = a.y as number;
  const dx = (b.x as number) - ax, dy = (b.y as number) - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return { primitives, error: 'El eje no puede tener longitud cero' };

  const reflect = (p: XY): XY => {
    const t = ((p.x - ax) * dx + (p.y - ay) * dy) / len2;
    const px = ax + t * dx, py = ay + t * dy;
    return { x: 2 * px - p.x, y: 2 * py - p.y };
  };

  // El eje no se espeja a sí mismo.
  const targets = (selection.length ? selection : []).filter((id) => id !== axisLineId);
  const { primitives: cloned, pointMap } = cloneGeometry(primitives, targets, reflect, true);

  let out = cloned;
  for (const [src, dst] of pointMap) {
    out = [...out, {
      id: freshId(out, 'c'), type: 'p2p_symmetric_ppl',
      p1_id: src, p2_id: dst, l_id: axisLineId,
    } as SketchItem];
  }
  return { primitives: out };
}

/** Patrón rectangular: `cols` x `rows` copias separadas por `dx` y `dy`. */
export function rectangularPattern(
  primitives: SketchItem[], selection: string[],
  cols: number, rows: number, dx: number, dy: number,
): ApplyResult {
  if (cols < 1 || rows < 1) return { primitives, error: 'Cantidades inválidas' };
  let out = primitives;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (i === 0 && j === 0) continue; // el original
      out = cloneGeometry(out, selection, (p) => ({ x: p.x + i * dx, y: p.y + j * dy })).primitives;
    }
  }
  return { primitives: out };
}

/** Patrón circular alrededor de un punto. */
export function circularPattern(
  primitives: SketchItem[], selection: string[],
  centerId: string, count: number, totalAngleDeg = 360,
): ApplyResult {
  const center = findPrim(primitives, centerId);
  if (!center || center.type !== 'point') return { primitives, error: 'Elegí un punto como centro' };
  if (count < 2) return { primitives, error: 'Hacen falta al menos 2 copias' };

  const cx = center.x as number, cy = center.y as number;
  // Con vuelta completa la última copia pisaría a la primera.
  const full = Math.abs(totalAngleDeg % 360) < 1e-9;
  const stepRad = ((totalAngleDeg * Math.PI) / 180) / (full ? count : count - 1);

  let out = primitives;
  for (let i = 1; i < count; i++) {
    const a = stepRad * i;
    const cos = Math.cos(a), sin = Math.sin(a);
    out = cloneGeometry(out, selection, (p) => ({
      x: cx + (p.x - cx) * cos - (p.y - cy) * sin,
      y: cy + (p.x - cx) * sin + (p.y - cy) * cos,
    })).primitives;
  }
  return { primitives: out };
}

/** Polígono regular inscrito en un círculo. */
export function addPolygon(
  primitives: SketchItem[], center: XY, vertex: XY, sides: number,
): SketchItem[] {
  if (sides < 3) return primitives;
  const r = Math.hypot(vertex.x - center.x, vertex.y - center.y);
  if (r < 1e-6) return primitives;
  const a0 = Math.atan2(vertex.y - center.y, vertex.x - center.x);

  let out = [...primitives];
  const ids = Array.from({ length: sides }, (_, i) => {
    const a = a0 + (i / sides) * 2 * Math.PI;
    const id = freshId(out, 'p');
    out = [...out, {
      id, type: 'point', x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a), fixed: false,
    }];
    return id;
  });
  const lineIds = ids.map((id, i) => {
    const lid = freshId(out, 'l');
    out = [...out, { id: lid, type: 'line', p1_id: id, p2_id: ids[(i + 1) % sides] }];
    return lid;
  });
  // Lados iguales: si no, deja de ser regular en cuanto se arrastre un vértice.
  for (let i = 1; i < sides; i++) {
    const cid = freshId(out, 'c');
    out = [...out, { id: cid, type: 'equal_length', l1_id: lineIds[0], l2_id: lineIds[i] }];
  }
  return out;
}

/**
 * Desfase de una cadena de líneas y de círculos.
 *
 * Cada línea se corre por su normal y los vértices salen de intersecar las
 * rectas desplazadas consecutivas, que es lo que mantiene los ángulos.
 */
export function offsetSelection(
  primitives: SketchItem[], selection: string[], distance: number,
): ApplyResult {
  const { curves } = resolveTargets(primitives, selection);
  if (curves.length === 0) return { primitives, error: 'No hay nada seleccionado' };

  let out = [...primitives];
  let made = 0;

  // Círculos: basta con cambiar el radio.
  for (const c of curves.filter((x) => x.type === 'circle')) {
    const r = (c.radius as number) + distance;
    if (r <= 1e-6) continue;
    out = [...out, {
      id: freshId(out, 'ci'), type: 'circle', c_id: c.c_id as string, radius: r,
    } as SketchItem];
    made++;
  }

  const lines = curves.filter((x) => x.type === 'line');
  if (lines.length > 0) {
    const pointOf = (id: string) => {
      const p = findPrim(out, id)!;
      return { x: p.x as number, y: p.y as number };
    };
    // Rectas desplazadas, en forma punto + dirección.
    const shifted = lines.map((l) => {
      const a = pointOf(l.p1_id as string);
      const b = pointOf(l.p2_id as string);
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
      return {
        a: { x: a.x + nx * distance, y: a.y + ny * distance },
        b: { x: b.x + nx * distance, y: b.y + ny * distance },
        p1: l.p1_id as string, p2: l.p2_id as string,
      };
    });

    const intersect = (
      p: XY, r: XY, q: XY, s: XY,
    ): XY | null => {
      const cross = r.x * s.y - r.y * s.x;
      if (Math.abs(cross) < 1e-9) return null; // paralelas
      const t = ((q.x - p.x) * s.y - (q.y - p.y) * s.x) / cross;
      return { x: p.x + t * r.x, y: p.y + t * r.y };
    };

    // Los extremos compartidos se recalculan intersecando las dos rectas.
    const corner = new Map<string, XY>();
    for (let i = 0; i < shifted.length; i++) {
      for (let j = i + 1; j < shifted.length; j++) {
        const si = shifted[i], sj = shifted[j];
        const shared = [si.p1, si.p2].find((p) => p === sj.p1 || p === sj.p2);
        if (!shared) continue;
        const hit = intersect(
          si.a, { x: si.b.x - si.a.x, y: si.b.y - si.a.y },
          sj.a, { x: sj.b.x - sj.a.x, y: sj.b.y - sj.a.y },
        );
        if (hit) corner.set(shared, hit);
      }
    }

    const newId = new Map<string, string>();
    const place = (origId: string, fallback: XY) => {
      const existing = newId.get(origId);
      if (existing) return existing;
      const at = corner.get(origId) ?? fallback;
      const id = freshId(out, 'p');
      out = [...out, { id, type: 'point', x: at.x, y: at.y, fixed: false }];
      newId.set(origId, id);
      return id;
    };

    for (const s of shifted) {
      const p1 = place(s.p1, s.a);
      const p2 = place(s.p2, s.b);
      out = [...out, {
        id: freshId(out, 'l'), type: 'line', p1_id: p1, p2_id: p2,
      } as SketchItem];
      made++;
    }
  }

  if (made === 0) return { primitives, error: 'Esa geometría no se puede desfasar' };
  return { primitives: out };
}
