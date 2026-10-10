/**
 * Descomposición del boceto en perfiles.
 *
 * Encadenar curvas por sus extremos no alcanza: una línea que cruza por el
 * medio de un triángulo lo parte en dos, y ninguno de los dos pedazos es una
 * cadena de curvas completas. Hay que partir las curvas donde se cruzan y
 * recorrer el grafo plano resultante cara por cara, que es lo que hace
 * cualquier CAD.
 */
import type { P2, SolvedCurve } from './sketch';
import { curveToPolyline } from './sketch';
import { intersectPoints, paramAt, pointAtParam } from './curves';

/**
 * Tolerancia para considerar que dos puntos son el mismo nodo del grafo.
 *
 * 1e-4 mm (una décima de micrón) es de sobra para una pieza y deja margen para
 * el error de las intersecciones calculadas por polilínea.
 */
const TOL = 1e-4;
const key = (p: P2) => `${Math.round(p.x / TOL)}:${Math.round(p.y / TOL)}`;

/** Un pedazo de curva entre dos cortes consecutivos. */
export interface CurvePiece {
  curve: SolvedCurve;
  /** Parámetros 0..1 sobre la curva original. */
  t0: number;
  t1: number;
  a: P2;
  b: P2;
  /** Polilínea del pedazo, para medir áreas y tangentes. */
  poly: P2[];
}

const isClosed = (c: SolvedCurve) =>
  c.kind === 'circle' || (c.kind === 'spline' && c.periodic);

/**
 * Muestrea el pedazo [t0, t1] de la curva.
 *
 * `t1` puede pasar de 1 en el pedazo que da la vuelta de una curva cerrada:
 * se recorre hacia adelante y el parámetro se envuelve, no se va para atrás.
 *
 * El muestreo define el área que se le muestra al usuario en la lista de
 * perfiles, así que conviene que sea fino: con 24 tramos un sector de círculo
 * quedaba casi un 1 % corto. La geometría del sólido no sale de acá, la
 * construye OCCT con la curva exacta.
 */
function piecePolyline(curve: SolvedCurve, t0: number, t1: number, steps = 64): P2[] {
  const wrap = (t: number) => (t > 1 ? t - 1 : t);
  if (curve.kind === 'line') {
    return [pointAtParam(curve, t0), pointAtParam(curve, wrap(t1))];
  }
  return Array.from({ length: steps + 1 }, (_, i) =>
    pointAtParam(curve, wrap(t0 + ((t1 - t0) * i) / steps)));
}

/**
 * Parte cada curva en los puntos donde cruza a las demás.
 *
 * Una curva sin cortes queda entera: abierta aporta un pedazo, cerrada aporta
 * un bucle propio.
 */
export function splitAtIntersections(curves: SolvedCurve[]): CurvePiece[] {
  /**
   * Los cortes se calculan una sola vez y se agrupan: si cada curva se partiera
   * en el punto que calculó por su cuenta, los dos extremos quedarían a un
   * micrón uno del otro y el grafo no cerraría. Todas las curvas que pasan por
   * un cruce usan exactamente el mismo punto.
   */
  const nodes = new Map<string, P2>();
  const canonical = (p: P2): P2 => {
    const k = key(p);
    const found = nodes.get(k);
    if (found) return found;
    nodes.set(k, p);
    return p;
  };

  // Los extremos de las curvas abiertas también son nodos.
  for (const c of curves) {
    if (isClosed(c)) continue;
    canonical(pointAtParam(c, 0));
    canonical(pointAtParam(c, 1));
  }
  for (let i = 0; i < curves.length; i++) {
    for (let j = i + 1; j < curves.length; j++) {
      for (const p of intersectPoints(curves[i], curves[j])) canonical(p);
    }
  }

  const out: CurvePiece[] = [];
  for (const curve of curves) {
    const cuts: { t: number; at: P2 }[] = [];
    for (const node of nodes.values()) {
      const t = paramAt(curve, node);
      const on = pointAtParam(curve, t);
      if (Math.hypot(on.x - node.x, on.y - node.y) > TOL) continue;
      if (t > 1e-7 && t < 1 - 1e-7) cuts.push({ t, at: node });
    }

    cuts.sort((a, b) => a.t - b.t);
    const uniq = cuts.filter((c, i) => i === 0 || c.t - cuts[i - 1].t > 1e-6);

    const closed = isClosed(curve);
    const bounds: { t: number; at: P2 }[] = closed
      ? (uniq.length === 0
        ? [{ t: 0, at: pointAtParam(curve, 0) }, { t: 1, at: pointAtParam(curve, 0) }]
        : [...uniq, { t: uniq[0].t + 1, at: uniq[0].at }])
      : [
        { t: 0, at: canonical(pointAtParam(curve, 0)) },
        ...uniq,
        { t: 1, at: canonical(pointAtParam(curve, 1)) },
      ];

    for (let i = 0; i < bounds.length - 1; i++) {
      const from = bounds[i], to = bounds[i + 1];
      if (to.t - from.t < 1e-7) continue;
      const poly = piecePolyline(curve, from.t, to.t);
      // Los extremos se fijan al nodo compartido, no al que dio el muestreo.
      poly[0] = from.at;
      poly[poly.length - 1] = to.at;
      out.push({ curve, t0: from.t, t1: to.t, a: from.at, b: to.at, poly });
    }
  }

  return out;
}

interface HalfEdge {
  piece: CurvePiece;
  reversed: boolean;
  from: string;
  to: string;
  /** Ángulo con el que sale de `from`. */
  angle: number;
  used: boolean;
  twin: HalfEdge;
}

const angleOf = (poly: P2[], reversed: boolean) => {
  const pts = reversed ? [...poly].reverse() : poly;
  return Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
};

export interface Face {
  pieces: { piece: CurvePiece; reversed: boolean }[];
  polyline: P2[];
  signedArea: number;
}

function polygonArea(poly: P2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/**
 * Caras mínimas del grafo plano.
 *
 * Se recorre cada semiarista girando siempre al siguiente en sentido horario
 * desde el gemelo del que llegó: así cada vuelta encierra una cara mínima y no
 * se saltea ninguna subdivisión. Las caras con área positiva son el interior;
 * la que da negativa es el contorno de afuera y se descarta.
 */
export function findFaces(curves: SolvedCurve[]): Face[] {
  const pieces = splitAtIntersections(curves);
  const edges: HalfEdge[] = [];

  for (const piece of pieces) {
    const ka = key(piece.a), kb = key(piece.b);
    if (ka === kb && piece.poly.length < 3) continue; // pedazo degenerado

    const fwd = {
      piece, reversed: false, from: ka, to: kb,
      angle: angleOf(piece.poly, false), used: false,
    } as HalfEdge;
    const bwd = {
      piece, reversed: true, from: kb, to: ka,
      angle: angleOf(piece.poly, true), used: false,
    } as HalfEdge;
    fwd.twin = bwd;
    bwd.twin = fwd;
    edges.push(fwd, bwd);
  }

  // Semiaristas que salen de cada nodo, ordenadas por ángulo.
  const outgoing = new Map<string, HalfEdge[]>();
  for (const e of edges) {
    if (!outgoing.has(e.from)) outgoing.set(e.from, []);
    outgoing.get(e.from)!.push(e);
  }
  for (const list of outgoing.values()) list.sort((a, b) => a.angle - b.angle);

  /** Siguiente semiarista al recorrer una cara: la anterior en sentido horario. */
  const next = (e: HalfEdge): HalfEdge | null => {
    const list = outgoing.get(e.to);
    if (!list || list.length === 0) return null;
    const twin = e.twin;
    const i = list.indexOf(twin);
    if (i < 0) return null;
    return list[(i - 1 + list.length) % list.length];
  };

  const faces: Face[] = [];
  for (const start of edges) {
    if (start.used) continue;

    const walk: HalfEdge[] = [];
    let e: HalfEdge | null = start;
    while (e && !e.used) {
      e.used = true;
      walk.push(e);
      e = next(e);
      if (e === start) break;
    }
    if (walk.length === 0) continue;

    const polyline: P2[] = [];
    for (const he of walk) {
      const pts = he.reversed ? [...he.piece.poly].reverse() : he.piece.poly;
      polyline.push(...pts.slice(0, -1));
    }
    if (polyline.length < 3) continue;

    faces.push({
      pieces: walk.map((he) => ({ piece: he.piece, reversed: he.reversed })),
      polyline,
      signedArea: polygonArea(polyline),
    });
  }

  // El contorno exterior de cada componente se recorre al revés que las caras
  // interiores, y queda con área negativa.
  return faces.filter((f) => f.signedArea > 1e-9);
}

/** Curvas que no forman parte de ninguna cara, para poder avisar. */
export const danglingCurves = (curves: SolvedCurve[], faces: Face[]): SolvedCurve[] => {
  const used = new Set(faces.flatMap((f) => f.pieces.map((p) => p.piece.curve)));
  return curves.filter((c) => !used.has(c) && !isClosed(c) && curveToPolyline(c).length > 1);
};
