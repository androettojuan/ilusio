/**
 * Pruebas de la lógica geométrica pura: detección de perfiles, recortar y las
 * herramientas de modificación. Nada de esto necesita el solver ni OCCT, así
 * que corre en milisegundos y sirve de red al tocar el kernel.
 */
import { describe, expect, it } from 'vitest';
import {
  findLoops, findRegions, orderedRegions, splinePolyline,
  type SolvedCurve, type SolvedSketch,
} from '../kernel/sketch';
import { rectFrom, segmentCrossesRect, selectInBox } from '../model/boxSelect';
import { gridStep, nearestGridVertex, snapToGrid } from '../model/grid';
import { PLANES, flipPlane, offsetPlane, to3d } from '../kernel/shapes';
import { planeKey, parsePlaneKey } from '../ui/PlanePicker';
import {
  collectDimensions, dimensionValue, inferDimension, isDimension,
  setDimensionValue, suggestedValue,
} from '../model/dimensions';
import { trimAt } from '../model/sketchTrim';
import {
  addPolygon, addRectangle, addSpline, applyConstraint, attachDraggedPoint,
  circularPattern, deletePrimitives, ensurePoint, freeSnap, mirror,
  offsetSelection, orphanPoints, pruneOrphanPoints, snapPoint,
} from '../model/sketchEdit';
import {
  addFeature, dependentsOf, emptyDocument, makeExtrude, makeFillet, makeSketch,
  removeFeatures, setRollback,
} from '../model/document';
import type { SketchItem } from '../model/types';

const line = (id: string, ax: number, ay: number, bx: number, by: number): SolvedCurve =>
  ({ id, kind: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by } });

const circle = (id: string, cx: number, cy: number, r: number): SolvedCurve =>
  ({ id, kind: 'circle', c: { x: cx, y: cy }, r });

/** Rectángulo cerrado de 0,0 a w,h. */
const rect = (w: number, h: number, p = 'l'): SolvedCurve[] => [
  line(`${p}1`, 0, 0, w, 0),
  line(`${p}2`, w, 0, w, h),
  line(`${p}3`, w, h, 0, h),
  line(`${p}4`, 0, h, 0, 0),
];

type SplineCurve = Extract<SolvedCurve, { kind: 'spline' }>;

const spline = (id: string, through: [number, number][], periodic = false): SplineCurve => ({
  id, kind: 'spline',
  through: through.map(([x, y]) => ({ x, y })),
  pointIds: through.map((_, i) => `${id}p${i}`),
  periodic,
});

const asSketch = (curves: SolvedCurve[]): SolvedSketch => ({
  curves, points: new Map(), status: 0,
  conflicting: [], redundant: [], underConstrained: false,
});

describe('detección de perfiles', () => {
  it('cierra un rectángulo de cuatro líneas', () => {
    const loops = findLoops(rect(80, 50));
    expect(loops).toHaveLength(1);
    expect(Math.abs(loops[0].signedArea)).toBeCloseTo(4000, 1);
  });

  it('descarta una cadena abierta', () => {
    const open = rect(80, 50).slice(0, 3);
    expect(findLoops(open)).toHaveLength(0);
  });

  it('un círculo es un bucle por sí solo', () => {
    const loops = findLoops([circle('c1', 0, 0, 10)]);
    expect(loops).toHaveLength(1);
    // El área sale de una polilínea de 24 lados, que sólo se usa para los tests
    // de contención; la geometría real la construye OCCT con el círculo exacto.
    // Un polígono de 24 lados inscrito queda ~1,1 % por debajo.
    expect(Math.abs(loops[0].signedArea)).toBeGreaterThan(Math.PI * 100 * 0.97);
    expect(Math.abs(loops[0].signedArea)).toBeLessThanOrEqual(Math.PI * 100);
  });

  it('reconoce un agujero dentro de un contorno', () => {
    const loops = findLoops([...rect(80, 50), circle('c1', 40, 25, 10)]);
    const regions = findRegions(loops);
    expect(regions).toHaveLength(1);
    expect(regions[0].holes).toHaveLength(1);
  });

  it('dos contornos separados son dos regiones', () => {
    const regions = findRegions(findLoops([
      circle('c1', 0, 0, 5), circle('c2', 50, 0, 5),
    ]));
    expect(regions).toHaveLength(2);
    expect(regions.every((r) => r.holes.length === 0)).toBe(true);
  });

  it('un agujero dentro de un agujero vuelve a ser contorno', () => {
    const regions = findRegions(findLoops([
      circle('ext', 0, 0, 30), circle('hueco', 0, 0, 20), circle('isla', 0, 0, 10),
    ]));
    // El anillo exterior con su hueco, y la isla central como región aparte.
    expect(regions).toHaveLength(2);
    const conHueco = regions.find((r) => r.holes.length === 1);
    expect(conHueco?.outer.signedArea).toBeDefined();
  });
});

describe('recortar', () => {
  const prims = (...ids: string[]): SketchItem[] =>
    ids.map((id) => ({ id, type: 'line', p1_id: `${id}a`, p2_id: `${id}b` }) as SketchItem);

  it('parte una línea en dos y borra el tramo del clic', () => {
    // Una horizontal cortada por dos verticales.
    const curves = [
      line('h', 0, 0, 100, 0),
      line('v1', 30, -10, 30, 10),
      line('v2', 70, -10, 70, 10),
    ];
    const res = trimAt(prims('h', 'v1', 'v2'), asSketch(curves), 'h', { x: 50, y: 0 });
    expect(res.error).toBeUndefined();
    const lines = res.primitives.filter((p) => (p as { type: string }).type === 'line');
    // v1, v2 y los dos trozos de h.
    expect(lines).toHaveLength(4);
  });

  it('sin cortes, recortar borra la curva entera', () => {
    const res = trimAt(prims('h'), asSketch([line('h', 0, 0, 100, 0)]), 'h', { x: 50, y: 0 });
    expect(res.primitives.filter((p) => (p as { type: string }).type === 'line')).toHaveLength(0);
  });

  it('un círculo cortado por una línea queda como arco', () => {
    const curves = [circle('c', 0, 0, 10), line('h', -20, 0, 20, 0)];
    const base: SketchItem[] = [
      { id: 'pc', type: 'point', x: 0, y: 0, fixed: false },
      { id: 'c', type: 'circle', c_id: 'pc', radius: 10 },
      { id: 'ha', type: 'point', x: -20, y: 0, fixed: false },
      { id: 'hb', type: 'point', x: 20, y: 0, fixed: false },
      { id: 'h', type: 'line', p1_id: 'ha', p2_id: 'hb' },
    ];
    // Clic arriba: tiene que quedar la mitad de abajo.
    const res = trimAt(base, asSketch(curves), 'c', { x: 0, y: 10 });
    expect(res.error).toBeUndefined();
    const arcs = res.primitives.filter((p) => (p as { type: string }).type === 'arc');
    expect(arcs).toHaveLength(1);
    expect(res.primitives.some((p) => (p as { type: string }).type === 'circle')).toBe(false);
  });
});

describe('herramientas de modificación', () => {
  it('el rectángulo trae sus restricciones horizontal y vertical', () => {
    const p = addRectangle([], { x: 0, y: 0 }, { x: 10, y: 5 });
    const types = p.map((x) => (x as { type: string }).type);
    expect(types.filter((t) => t === 'point')).toHaveLength(4);
    expect(types.filter((t) => t === 'line')).toHaveLength(4);
    expect(types.filter((t) => t === 'horizontal_l')).toHaveLength(2);
    expect(types.filter((t) => t === 'vertical_l')).toHaveLength(2);
  });

  it('el polígono regular ata sus lados con igualdad', () => {
    const p = addPolygon([], { x: 0, y: 0 }, { x: 10, y: 0 }, 6);
    const types = p.map((x) => (x as { type: string }).type);
    expect(types.filter((t) => t === 'line')).toHaveLength(6);
    expect(types.filter((t) => t === 'equal_length')).toHaveLength(5);
  });

  it('la simetría copia la geometría y deja la restricción puesta', () => {
    let p = addRectangle([], { x: 10, y: 0 }, { x: 20, y: 10 });
    // Un eje vertical sobre el que espejar.
    p = [...p,
      { id: 'ea', type: 'point', x: 0, y: -10, fixed: true },
      { id: 'eb', type: 'point', x: 0, y: 20, fixed: true },
      { id: 'eje', type: 'line', p1_id: 'ea', p2_id: 'eb' },
    ] as SketchItem[];
    const target = p.filter((x) => (x as { type: string }).type === 'line')
      .map((x) => (x as { id: string }).id).filter((id) => id !== 'eje');

    const res = mirror(p, [...target, 'eje'], 'eje');
    expect(res.error).toBeUndefined();
    const types = res.primitives.map((x) => (x as { type: string }).type);
    expect(types.filter((t) => t === 'line')).toHaveLength(9); // 4 + 4 + eje
    expect(types.filter((t) => t === 'p2p_symmetric_ppl').length).toBeGreaterThan(0);
  });

  it('el patrón circular crea las copias pedidas', () => {
    const base: SketchItem[] = [
      { id: 'o', type: 'point', x: 0, y: 0, fixed: true },
      { id: 'pc', type: 'point', x: 20, y: 0, fixed: false },
      { id: 'c1', type: 'circle', c_id: 'pc', radius: 3 },
    ];
    const res = circularPattern(base, ['c1'], 'o', 6, 360);
    expect(res.error).toBeUndefined();
    expect(res.primitives.filter((p) => (p as { type: string }).type === 'circle')).toHaveLength(6);
  });

  it('el desfase de un círculo cambia el radio', () => {
    const base: SketchItem[] = [
      { id: 'pc', type: 'point', x: 0, y: 0, fixed: false },
      { id: 'c1', type: 'circle', c_id: 'pc', radius: 10 },
    ];
    const res = offsetSelection(base, ['c1'], 2.5);
    const radios = res.primitives
      .filter((p) => (p as { type: string }).type === 'circle')
      .map((p) => (p as unknown as { radius: number }).radius);
    expect(radios.sort()).toEqual([10, 12.5]);
  });

  it('borrar una línea se lleva sus restricciones', () => {
    const p = addRectangle([], { x: 0, y: 0 }, { x: 10, y: 5 });
    const firstLine = p.find((x) => (x as { type: string }).type === 'line') as { id: string };
    const out = deletePrimitives(p, [firstLine.id]);
    expect(out.filter((x) => (x as { type: string }).type === 'line')).toHaveLength(3);
    // La horizontal_l que apuntaba a esa línea tiene que haberse ido también.
    const hv = out.filter((x) => ['horizontal_l', 'vertical_l'].includes((x as { type: string }).type));
    expect(hv).toHaveLength(3);
  });
});


describe('curva por puntos', () => {
  it('la polilínea pasa exactamente por los puntos marcados', () => {
    const through = [
      { x: 0, y: 0 }, { x: 20, y: 30 }, { x: 50, y: -10 }, { x: 80, y: 25 },
    ];
    const poly = splinePolyline(through, false);
    for (const p of through) {
      const d = Math.min(...poly.map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
      expect(d).toBeLessThan(1e-9);
    }
  });

  it('cierra un perfil junto con una línea', () => {
    // La curva se mantiene de un solo lado de la línea, así que encierran una
    // única región. (Si la cruzara, la descomposición la partiría en varias,
    // que es justamente lo que tiene que hacer.)
    const loops = findLoops([
      spline('s1', [[0, 0], [30, 25], [60, 25], [90, 0]]),
      line('l1', 90, 0, 0, 0),
    ]);
    expect(loops).toHaveLength(1);
    expect(loops[0].segments).toHaveLength(2);
  });

  it('una curva cerrada es un bucle por sí sola', () => {
    const loops = findLoops([spline('s1', [[0, 0], [40, 20], [60, -20]], true)]);
    expect(loops).toHaveLength(1);
  });

  it('addSpline reutiliza los puntos que ya existen', () => {
    // Dos clics sobre el mismo lugar no pueden crear dos puntos.
    const out = addSpline([], [
      freeSnap({ x: 0, y: 0 }), freeSnap({ x: 10, y: 10 }), freeSnap({ x: 20, y: 0 }),
    ], 0.5);
    const sp = out.find((p) => (p as { type: string }).type === 'spline') as
      { point_ids: string[] };
    expect(sp.point_ids).toHaveLength(3);
    expect(out.filter((p) => (p as { type: string }).type === 'point')).toHaveLength(3);
  });

  it('borrar un punto de la curva se lleva la curva', () => {
    const out = addSpline([], [
      freeSnap({ x: 0, y: 0 }), freeSnap({ x: 10, y: 10 }), freeSnap({ x: 20, y: 0 }),
    ], 0.5);
    const firstPoint = out.find((p) => (p as { type: string }).type === 'point') as { id: string };
    const after = deletePrimitives(out, [firstPoint.id]);
    expect(after.filter((p) => (p as { type: string }).type === 'spline')).toHaveLength(0);
  });
});

describe('enganche al dibujar', () => {
  it('sobre un punto existente lo reutiliza en vez de crear otro', () => {
    const base: SketchItem[] = [{ id: 'p1', type: 'point', x: 5, y: 5, fixed: false }];
    const res = ensurePoint(base, { at: { x: 5, y: 5 }, pointId: 'p1' }, 1);
    expect(res.id).toBe('p1');
    expect(res.primitives).toHaveLength(1);
  });

  it('sobre una línea deja puesta la restricción punto-sobre-línea', () => {
    const base: SketchItem[] = [
      { id: 'a', type: 'point', x: 0, y: 0, fixed: false },
      { id: 'b', type: 'point', x: 10, y: 0, fixed: false },
      { id: 'l1', type: 'line', p1_id: 'a', p2_id: 'b' },
    ];
    const res = ensurePoint(
      base, { at: { x: 5, y: 0 }, curveId: 'l1', curveType: 'line' }, 0.1,
    );
    const c = res.primitives.find((p) => (p as { type: string }).type === 'point_on_line_pl');
    expect(c).toBeDefined();
    expect((c as unknown as { l_id: string }).l_id).toBe('l1');
    expect((c as unknown as { p_id: string }).p_id).toBe(res.id);
  });
});

describe('perfiles con índice estable', () => {
  const tresCirculos = [
    circle('c1', 40, 0, 10), circle('c2', -40, 0, 10), circle('c3', 0, 0, 10),
  ];

  it('ordena por centroide, no por orden de dibujo', () => {
    const regions = orderedRegions(tresCirculos);
    [-40, 0, 40].forEach((x, i) => expect(regions[i].centroid.x).toBeCloseTo(x, 6));
    expect(regions.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it('agregar geometría a la derecha no renumera los perfiles de la izquierda', () => {
    const antes = orderedRegions(tresCirculos);
    const despues = orderedRegions([...tresCirculos, circle('c4', 200, 0, 5)]);
    for (const r of antes) {
      const mismo = despues.find((x) => Math.abs(x.centroid.x - r.centroid.x) < 1e-6);
      expect(mismo?.index).toBe(r.index);
    }
  });

  it('el área descuenta los agujeros', () => {
    const regions = orderedRegions([...rect(100, 60), circle('h', 50, 30, 10)]);
    expect(regions).toHaveLength(1);
    // El agujero se muestrea con 24 lados, así que queda apenas por encima.
    expect(regions[0].area).toBeGreaterThan(6000 - Math.PI * 100);
    expect(regions[0].area).toBeLessThan(6000 - Math.PI * 100 * 0.97);
  });
});


describe('recortar curvas por puntos', () => {
  /** Boceto mínimo con dos curvas cruzadas: una onda y una casi recta. */
  const onda = spline('onda', [[0, 0], [25, 40], [50, 0], [75, 40], [100, 0]]);
  const recta = spline('recta', [[0, 20], [50, 20], [100, 20]]);

  const base: SketchItem[] = [
    ...[[0, 0], [25, 40], [50, 0], [75, 40], [100, 0]].map(([x, y], i) => (
      { id: `ondap${i}`, type: 'point', x, y, fixed: false } as SketchItem)),
    { id: 'onda', type: 'spline', point_ids: [0, 1, 2, 3, 4].map((i) => `ondap${i}`), periodic: false },
    ...[[0, 20], [50, 20], [100, 20]].map(([x, y], i) => (
      { id: `rectap${i}`, type: 'point', x, y, fixed: false } as SketchItem)),
    { id: 'recta', type: 'spline', point_ids: [0, 1, 2].map((i) => `rectap${i}`), periodic: false },
  ];

  const sketch = asSketch([onda, recta]);
  const splines = (items: SketchItem[]) =>
    items.filter((p) => (p as { type: string }).type === 'spline');

  it('parte la curva en los cruces y borra sólo el tramo del clic', () => {
    // La recta corta a la onda cuatro veces, así que queda en cinco tramos;
    // el clic en el segundo lo elimina y deben quedar cuatro.
    const res = trimAt(base, sketch, 'recta', { x: 25, y: 20 });
    expect(res.error).toBeUndefined();
    const out = splines(res.primitives);
    expect(out.find((p) => (p as { id: string }).id === 'onda')).toBeDefined();
    // La onda sigue entera, la recta quedó en cuatro pedazos.
    expect(out).toHaveLength(5);
  });

  it('el tramo reconstruido sigue la curva original', () => {
    const res = trimAt(base, sketch, 'onda', { x: 25, y: 20 });
    const piezas = splines(res.primitives).filter((p) => (p as { id: string }).id !== 'recta');
    const puntos = new Map(
      res.primitives
        .filter((p) => (p as { type: string }).type === 'point')
        .map((p) => {
          const q = p as unknown as { id: string; x: number; y: number };
          return [q.id, { x: q.x, y: q.y }];
        }),
    );

    // Cada punto de cada pedazo tiene que caer sobre la onda original. Se mide
    // contra los segmentos, no contra los vértices: con vértices, un punto
    // exactamente sobre la curva ya da la mitad del paso de muestreo.
    const original = splinePolyline(onda.through, false, 128);
    const distToPolyline = (p: { x: number; y: number }) => {
      let best = Infinity;
      for (let i = 0; i < original.length - 1; i++) {
        const a2 = original[i], b2 = original[i + 1];
        const dx = b2.x - a2.x, dy = b2.y - a2.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a2.x) * dx + (p.y - a2.y) * dy) / len2));
        best = Math.min(best, Math.hypot(p.x - (a2.x + t * dx), p.y - (a2.y + t * dy)));
      }
      return best;
    };

    for (const pieza of piezas) {
      for (const id of (pieza as unknown as { point_ids: string[] }).point_ids) {
        expect(distToPolyline(puntos.get(id)!)).toBeLessThan(0.02);
      }
    }
  });

  it('conserva el id de los puntos originales que sobreviven', () => {
    const res = trimAt(base, sketch, 'onda', { x: 25, y: 20 });
    const ids = splines(res.primitives)
      .filter((p) => (p as { id: string }).id !== 'recta')
      .flatMap((p) => (p as unknown as { point_ids: string[] }).point_ids);
    // El último punto de la onda no se tocó: su id tiene que seguir ahí, o la
    // geometría enganchada a ese extremo quedaría suelta.
    expect(ids).toContain('ondap4');
  });

  it('sin cruces, recortar borra la curva entera', () => {
    const sola: SketchItem[] = base.slice(0, 6);
    const res = trimAt(sola, asSketch([onda]), 'onda', { x: 25, y: 20 });
    expect(splines(res.primitives)).toHaveLength(0);
  });
});


describe('puntos sueltos', () => {
  const tipo = (p: SketchItem) => (p as { type: string }).type;
  const cuenta = (items: SketchItem[], t: string) => items.filter((p) => tipo(p) === t).length;

  it('borrar una curva se lleva los puntos que la sostenían', () => {
    const out = addSpline([], [
      freeSnap({ x: 0, y: 0 }), freeSnap({ x: 10, y: 20 }), freeSnap({ x: 30, y: 0 }),
    ], 0.5);
    expect(cuenta(out, 'point')).toBe(3);

    const sp = out.find((p) => tipo(p) === 'spline') as { id: string };
    const after = deletePrimitives(out, [sp.id]);
    expect(cuenta(after, 'point')).toBe(0);
  });

  it('no toca los puntos que otra geometría sigue usando', () => {
    // Un rectángulo y una línea suelta que comparte una esquina.
    let items = addRectangle([], { x: 0, y: 0 }, { x: 10, y: 10 });
    const esquina = (items.find((p) => tipo(p) === 'point') as { id: string }).id;
    items = [...items,
      { id: 'extra', type: 'point', x: 50, y: 50, fixed: false },
      { id: 'suelta', type: 'line', p1_id: esquina, p2_id: 'extra' },
    ] as SketchItem[];

    const after = deletePrimitives(items, ['suelta']);
    // Se va 'extra' (no lo usa nadie más) pero la esquina queda: la usa el rectángulo.
    expect(after.some((p) => (p as { id: string }).id === 'extra')).toBe(false);
    expect(after.some((p) => (p as { id: string }).id === esquina)).toBe(true);
    expect(cuenta(after, 'line')).toBe(4);
  });

  it('un punto suelto se lleva también sus cotas', () => {
    const items: SketchItem[] = [
      { id: 'a', type: 'point', x: 0, y: 0, fixed: false },
      { id: 'b', type: 'point', x: 10, y: 0, fixed: false },
      { id: 'l1', type: 'line', p1_id: 'a', p2_id: 'b' },
      { id: 'suelto', type: 'point', x: 50, y: 0, fixed: false },
      { id: 'cota', type: 'p2p_distance', p1_id: 'a', p2_id: 'suelto', distance: 50 },
    ] as SketchItem[];

    const after = pruneOrphanPoints(items);
    expect(after.some((p) => (p as { id: string }).id === 'suelto')).toBe(false);
    expect(after.some((p) => (p as { id: string }).id === 'cota')).toBe(false);
    expect(cuenta(after, 'line')).toBe(1);
  });

  it('los limpia aunque estén fijos', () => {
    // Los puntos importados de un SVG vienen fijos; si su línea ya no está,
    // tampoco sirven.
    const items: SketchItem[] = [
      { id: 'f1', type: 'point', x: 0, y: 0, fixed: true },
      { id: 'f2', type: 'point', x: 10, y: 0, fixed: true },
    ] as SketchItem[];
    expect(orphanPoints(items)).toHaveLength(2);
    expect(pruneOrphanPoints(items)).toHaveLength(0);
  });

  it('un boceto sano no tiene ninguno', () => {
    expect(orphanPoints(addRectangle([], { x: 0, y: 0 }, { x: 5, y: 5 }))).toHaveLength(0);
  });
});


describe('selección por ventana', () => {
  const curves = [
    circle('c1', 0, 0, 10),
    circle('c2', 50, 0, 10),
    line('l1', -40, -40, 40, -40),
  ];
  const points = new Map([
    ['p1', { x: 0, y: 0 }],
    ['p2', { x: 50, y: 0 }],
    ['lejos', { x: 500, y: 500 }],
  ]);

  const run = (a: [number, number], b: [number, number], crossing: boolean) =>
    selectInBox({
      curves, points,
      rect: rectFrom({ x: a[0], y: a[1] }, { x: b[0], y: b[1] }),
      crossing,
    }).sort();

  it('en modo ventana sólo entra lo que queda entero adentro', () => {
    // Encierra el primer círculo completo y corta el segundo por la mitad.
    expect(run([-20, -20], [50, 20], false)).toEqual(['c1', 'p1', 'p2']);
  });

  it('en modo cruce entra todo lo que la ventana toque', () => {
    expect(run([-20, -20], [50, 20], true)).toEqual(['c1', 'c2', 'p1', 'p2']);
  });

  it('una ventana fina que cruza por el medio agarra las dos figuras', () => {
    // Una banda horizontal que no contiene ningún vértice entero.
    expect(run([-100, -1], [100, 1], true)).toEqual(['c1', 'c2', 'p1', 'p2']);
    // En modo ventana, nada queda entero adentro.
    expect(run([-100, -1], [100, 1], false)).toEqual(['p1', 'p2']);
  });

  it('deja afuera lo que no toca', () => {
    expect(run([200, 200], [300, 300], true)).toEqual([]);
  });

  it('un segmento que atraviesa el rectángulo sin vértices adentro cuenta', () => {
    const r = rectFrom({ x: 0, y: 0 }, { x: 10, y: 10 });
    expect(segmentCrossesRect({ x: -5, y: 5 }, { x: 15, y: 5 }, r)).toBe(true);
    expect(segmentCrossesRect({ x: -5, y: 50 }, { x: 15, y: 50 }, r)).toBe(false);
  });
});


describe('cuadrícula', () => {
  it('el paso es siempre un valor redondo', () => {
    for (const scale of [0.05, 0.3, 1, 2.5, 4, 17, 60, 300]) {
      const step = gridStep(scale);
      const mantisa = step / Math.pow(10, Math.floor(Math.log10(step)));
      expect([1, 2, 5, 10]).toContain(Math.round(mantisa * 1e6) / 1e6);
    }
  });

  it('deja al menos 70 px entre líneas', () => {
    for (const scale of [0.05, 0.3, 1, 2.5, 4, 17, 60, 300]) {
      expect(gridStep(scale) * scale).toBeGreaterThanOrEqual(70 - 1e-9);
    }
  });

  it('el paso crece al alejarse y se achica al acercarse', () => {
    expect(gridStep(1)).toBeGreaterThan(gridStep(10));
    expect(gridStep(10)).toBeGreaterThan(gridStep(100));
  });

  it('redondea al vértice más cercano', () => {
    expect(nearestGridVertex({ x: 21.2, y: -18.9 }, 10)).toEqual({ x: 20, y: -20 });
    expect(nearestGridVertex({ x: 0, y: 0 }, 20)).toEqual({ x: 0, y: 0 });
  });

  it('sólo engancha si el cursor está cerca', () => {
    // El vértice (20,20) con paso 20: desde (21,21) sí, desde (28,28) no.
    expect(snapToGrid({ x: 21, y: 21 }, 20, 2.5)).toEqual({ x: 20, y: 20 });
    expect(snapToGrid({ x: 28, y: 28 }, 20, 2.5)).toBeNull();
  });

  it('mide la distancia al vértice, no por eje', () => {
    // Pegado a la línea y = 0 pero lejos del vértice en x: no engancha, o si
    // no, todo lo que pase cerca de una línea saltaría al vértice.
    expect(snapToGrid({ x: 10, y: 0.5 }, 20, 2.5)).toBeNull();
  });
});


describe('editar y borrar features', () => {
  /** Documento con boceto, extrusión que lo usa, y un empalme. */
  const build = () => {
    let doc = emptyDocument('prueba');
    const sketch = makeSketch(doc);
    doc = addFeature(doc, sketch);
    const extrude = makeExtrude(doc, sketch.id);
    doc = addFeature(doc, extrude);
    const fillet = makeFillet(doc);
    doc = addFeature(doc, fillet);
    return { doc, sketch, extrude, fillet };
  };

  it('sabe qué features dependen de un boceto', () => {
    const { doc, sketch, extrude } = build();
    expect(dependentsOf(doc, sketch.id).map((f) => f.id)).toEqual([extrude.id]);
  });

  it('el empalme no depende de nada por id', () => {
    const { doc, fillet } = build();
    expect(dependentsOf(doc, fillet.id)).toEqual([]);
  });

  it('borrar en cascada se lleva el boceto y lo que lo usaba', () => {
    const { doc, sketch, extrude, fillet } = build();
    const after = removeFeatures(doc, [sketch.id, extrude.id]);
    expect(after.features.map((f) => f.id)).toEqual([fillet.id]);
  });

  it('borrar sólo el boceto deja la extrusión en pie para reapuntarla', () => {
    const { doc, sketch, extrude } = build();
    const after = removeFeatures(doc, [sketch.id]);
    expect(after.features.map((f) => f.id)).toContain(extrude.id);
  });

  it('el marcador del historial se corrige al borrar lo que tenía delante', () => {
    const { doc, sketch, extrude } = build();
    // Marcador al final (3). Al borrar dos features anteriores, baja a 1.
    expect(doc.rollbackIndex).toBe(3);
    expect(removeFeatures(doc, [sketch.id, extrude.id]).rollbackIndex).toBe(1);
  });

  it('borrar algo que está después del marcador no lo mueve', () => {
    const { doc, fillet } = build();
    const rolled = setRollback(doc, 1);
    expect(removeFeatures(rolled, [fillet.id]).rollbackIndex).toBe(1);
  });
});


describe('planos de boceto', () => {
  it('los planos base mapean el 2D donde corresponde', () => {
    expect(to3d(PLANES.XY, { x: 3, y: 5 })).toEqual([3, 5, 0]);
    expect(to3d(PLANES.XZ, { x: 3, y: 5 })).toEqual([3, 0, 5]);
    expect(to3d(PLANES.YZ, { x: 3, y: 5 })).toEqual([0, 3, 5]);
  });

  it('el desfase corre el origen por la normal, sin girar los ejes', () => {
    const p = offsetPlane(PLANES.XY, 40);
    expect(p.o).toEqual([0, 0, 40]);
    expect(p.u).toEqual(PLANES.XY.u);
    expect(p.n).toEqual(PLANES.XY.n);
    expect(to3d(p, { x: 3, y: 5 })).toEqual([3, 5, 40]);
  });

  it('un desfase negativo va para el otro lado', () => {
    expect(offsetPlane(PLANES.XZ, 10).o).toEqual([0, -10, 0]);
  });

  it('invertir la normal mantiene el plano dextrógiro', () => {
    const f = flipPlane(PLANES.XY);
    expect(f.n).toEqual([-0, -0, -1]);
    // u x v tiene que seguir dando n.
    const cross: [number, number, number] = [
      f.u[1] * f.v[2] - f.u[2] * f.v[1],
      f.u[2] * f.v[0] - f.u[0] * f.v[2],
      f.u[0] * f.v[1] - f.u[1] * f.v[0],
    ];
    cross.forEach((c, i) => expect(c).toBeCloseTo(f.n[i], 9));
  });

  it('el desfase se acumula sobre un plano ya desfasado', () => {
    expect(offsetPlane(offsetPlane(PLANES.XY, 10), 15).o).toEqual([0, 0, 25]);
  });

  it('las referencias de plano sobreviven la ida y vuelta a texto', () => {
    const refs = [
      { kind: 'base', plane: 'XZ' },
      { kind: 'plane', featureId: 'pl_abc123' },
      { kind: 'face', faceIndex: 7 },
    ] as const;
    for (const ref of refs) expect(parsePlaneKey(planeKey(ref))).toEqual(ref);
  });
});


describe('cotas', () => {
  const solved = (): SolvedSketch => ({
    curves: [line('l1', 0, 0, 40, 0), circle('c1', 10, 30, 8)],
    points: new Map([
      ['a', { x: 0, y: 0 }], ['b', { x: 40, y: 0 }], ['cc', { x: 10, y: 30 }],
    ]),
    status: 0, conflicting: [], redundant: [], underConstrained: false,
  });

  const base: SketchItem[] = [
    { id: 'a', type: 'point', x: 0, y: 0, fixed: false },
    { id: 'b', type: 'point', x: 40, y: 0, fixed: false },
    { id: 'l1', type: 'line', p1_id: 'a', p2_id: 'b' },
    { id: 'cc', type: 'point', x: 10, y: 30, fixed: false },
    { id: 'c1', type: 'circle', c_id: 'cc', radius: 8 },
  ] as SketchItem[];

  it('reconoce qué restricciones son cotas', () => {
    expect(isDimension({ id: 'd', type: 'p2p_distance', p1_id: 'a', p2_id: 'b', distance: 40 } as SketchItem)).toBe(true);
    expect(isDimension({ id: 'h', type: 'horizontal_l', l_id: 'l1' } as SketchItem)).toBe(false);
  });

  it('dibuja una distancia entre sus dos puntos', () => {
    const items = [...base, { id: 'd1', type: 'p2p_distance', p1_id: 'a', p2_id: 'b', distance: 40 }] as SketchItem[];
    const dims = collectDimensions(items, solved());
    expect(dims).toHaveLength(1);
    expect(dims[0]).toMatchObject({ kind: 'distance', value: 40, text: '40' });
    expect(dims[0].a).toEqual({ x: 0, y: 0 });
    expect(dims[0].b).toEqual({ x: 40, y: 0 });
  });

  it('el radio sale del centro y el diámetro cruza el círculo', () => {
    const r = collectDimensions(
      [...base, { id: 'r1', type: 'circle_radius', c_id: 'c1', radius: 8 }] as SketchItem[],
      solved(),
    )[0];
    expect(r.kind).toBe('radius');
    expect(r.a).toEqual({ x: 10, y: 30 });

    const d = collectDimensions(
      [...base, { id: 'd1', type: 'circle_diameter', c_id: 'c1', diameter: 16 }] as SketchItem[],
      solved(),
    )[0];
    expect(d.kind).toBe('diameter');
    // Los dos extremos están sobre el círculo, uno a cada lado del centro.
    expect(Math.hypot(d.a.x - 10, d.a.y - 30)).toBeCloseTo(8, 6);
    expect(Math.hypot(d.b.x - 10, d.b.y - 30)).toBeCloseTo(8, 6);
  });

  it('el ángulo se muestra en grados aunque se guarde en radianes', () => {
    const items = [
      ...base,
      { id: 'p', type: 'point', x: 0, y: 0, fixed: false },
      { id: 'q', type: 'point', x: 0, y: 20, fixed: false },
      { id: 'l2', type: 'line', p1_id: 'p', p2_id: 'q' },
      { id: 'ang', type: 'l2l_angle_ll', l1_id: 'l1', l2_id: 'l2', angle: Math.PI / 2 },
    ] as SketchItem[];
    const s2 = solved();
    s2.curves.push(line('l2', 0, 0, 0, 20));
    const dim = collectDimensions(items, s2).find((d) => d.kind === 'angle');
    expect(dim?.text).toBe('90°');
    expect(dim?.vertex).toEqual({ x: 0, y: 0 });
  });

  it('cambiar el valor toca sólo esa cota', () => {
    const items = [
      ...base,
      { id: 'd1', type: 'p2p_distance', p1_id: 'a', p2_id: 'b', distance: 40 },
      { id: 'r1', type: 'circle_radius', c_id: 'c1', radius: 8 },
    ] as SketchItem[];
    const out = setDimensionValue(items, 'd1', 25);
    expect(dimensionValue(out.find((p) => (p as { id: string }).id === 'd1')!)).toBe(25);
    expect(dimensionValue(out.find((p) => (p as { id: string }).id === 'r1')!)).toBe(8);
  });

  it('propone el valor que ya mide la geometría', () => {
    const s2 = solved();
    expect(suggestedValue('distance', ['a', 'b'], s2)).toBeCloseTo(40, 6);
    expect(suggestedValue('distance', ['l1'], s2)).toBeCloseTo(40, 6);
    expect(suggestedValue('radius', ['c1'], s2)).toBeCloseTo(8, 6);
    expect(suggestedValue('diameter', ['c1'], s2)).toBeCloseTo(16, 6);
  });

  it('omite las cotas cuya geometría ya no está', () => {
    const items = [
      { id: 'd1', type: 'p2p_distance', p1_id: 'fantasma', p2_id: 'b', distance: 40 },
    ] as SketchItem[];
    expect(collectDimensions(items, solved())).toHaveLength(0);
  });

  it('respeta el corrimiento guardado de la etiqueta', () => {
    const items = [...base, { id: 'd1', type: 'p2p_distance', p1_id: 'a', p2_id: 'b', distance: 40 }] as SketchItem[];
    const dims = collectDimensions(items, solved(), { d1: [5, -12] });
    expect(dims[0].offset).toEqual({ x: 5, y: -12 });
  });
});


describe('herramienta de cota', () => {
  /** Rectángulo 40x20 con esquina en el origen, más un círculo r=8. */
  const items: SketchItem[] = [
    { id: 'a', type: 'point', x: 0, y: 0, fixed: false },
    { id: 'b', type: 'point', x: 40, y: 0, fixed: false },
    { id: 'c', type: 'point', x: 40, y: 20, fixed: false },
    { id: 'd', type: 'point', x: 0, y: 20, fixed: false },
    { id: 'abajo', type: 'line', p1_id: 'a', p2_id: 'b' },
    { id: 'derecha', type: 'line', p1_id: 'b', p2_id: 'c' },
    { id: 'arriba', type: 'line', p1_id: 'c', p2_id: 'd' },
    { id: 'cc', type: 'point', x: 10, y: 50, fixed: false },
    { id: 'circ', type: 'circle', c_id: 'cc', radius: 8 },
    { id: 'ac', type: 'point', x: 60, y: 60, fixed: false },
    { id: 'arco', type: 'arc', c_id: 'ac', radius: 5, start_id: 'a', end_id: 'b', start_angle: 0, end_angle: 1 },
  ] as SketchItem[];

  const sol: SolvedSketch = {
    curves: [
      line('abajo', 0, 0, 40, 0),
      line('derecha', 40, 0, 40, 20),
      line('arriba', 40, 20, 0, 20),
      circle('circ', 10, 50, 8),
      { id: 'arco', kind: 'arc', c: { x: 60, y: 60 }, r: 5, a0: 0, a1: 1, start: { x: 65, y: 60 }, end: { x: 62.7, y: 64.2 } },
    ],
    points: new Map([
      ['a', { x: 0, y: 0 }], ['b', { x: 40, y: 0 }],
      ['c', { x: 40, y: 20 }], ['d', { x: 0, y: 20 }],
      ['cc', { x: 10, y: 50 }], ['ac', { x: 60, y: 60 }],
    ]),
    status: 0, conflicting: [], redundant: [], underConstrained: true,
  };

  const infer = (picks: string[]) => inferDimension(items, sol, picks);

  it('una línea da su largo', () => {
    const r = infer(['abajo']);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.dim).toMatchObject({ kind: 'distance', value: 40 });
  });

  it('un círculo da el diámetro y un arco el radio', () => {
    const c = infer(['circ']);
    const a = infer(['arco']);
    expect(c.status === 'ok' && c.dim.kind).toBe('diameter');
    expect(c.status === 'ok' && c.dim.value).toBe(16);
    expect(a.status === 'ok' && a.dim.kind).toBe('radius');
    expect(a.status === 'ok' && a.dim.value).toBe(5);
  });

  it('dos puntos dan la distancia entre ellos', () => {
    const r = infer(['a', 'c']);
    expect(r.status === 'ok' && r.dim.kind).toBe('distance');
    expect(r.status === 'ok' && Math.round(r.dim.value)).toBe(45);
  });

  it('un punto y una línea dan la distancia perpendicular', () => {
    const r = infer(['d', 'abajo']);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.dim.value).toBeCloseTo(20, 6);
    // El punto va primero: es lo que espera la restricción p2l.
    expect(r.dim.ids).toEqual(['d', 'abajo']);
  });

  it('dos líneas que se cortan dan el ángulo, anclado en el vértice', () => {
    const r = infer(['abajo', 'derecha']);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.dim.kind).toBe('angle');
    expect((r.dim.value * 180) / Math.PI).toBeCloseTo(90, 6);
    expect(r.dim.anchor).toEqual({ x: 40, y: 0 });
  });

  it('dos líneas paralelas dan la separación, no un ángulo de cero', () => {
    const r = infer(['abajo', 'arriba']);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.dim.kind).toBe('distance');
    expect(r.dim.value).toBeCloseTo(20, 6);
  });

  it('un punto solo no alcanza', () => {
    expect(infer(['a']).status).toBe('need-more');
  });

  it('sin nada elegido pide que se elija algo', () => {
    expect(infer([]).status).toBe('need-more');
  });

  it('avisa cuando no sabe qué medir', () => {
    const r = infer(['circ', 'arco']);
    expect(r.status).toBe('invalid');
  });
});


describe('colineal y unión de puntos', () => {
  const tipo = (p: SketchItem) => (p as { type: string }).type;
  const dosLineas: SketchItem[] = [
    { id: 'a', type: 'point', x: 0, y: 0, fixed: false },
    { id: 'b', type: 'point', x: 10, y: 0, fixed: false },
    { id: 'l1', type: 'line', p1_id: 'a', p2_id: 'b' },
    { id: 'c', type: 'point', x: 30, y: 5, fixed: false },
    { id: 'd', type: 'point', x: 40, y: 7, fixed: false },
    { id: 'l2', type: 'line', p1_id: 'c', p2_id: 'd' },
  ] as SketchItem[];

  it('colineal pone los dos extremos de la segunda línea sobre la primera', () => {
    const res = applyConstraint(dosLineas, 'collinear', ['l1', 'l2']);
    expect(res.error).toBeUndefined();
    const puestas = res.primitives.filter((p) => tipo(p) === 'point_on_line_pl');
    expect(puestas).toHaveLength(2);
    // Los dos extremos de l2, contra l1.
    const sobre = puestas.map((p) => (p as unknown as { p_id: string; l_id: string }));
    expect(sobre.map((x) => x.p_id).sort()).toEqual(['c', 'd']);
    expect(sobre.every((x) => x.l_id === 'l1')).toBe(true);
  });

  it('soltar un punto sobre otro los vuelve coincidentes', () => {
    const out = attachDraggedPoint(dosLineas, 'b', { at: { x: 30, y: 5 }, pointId: 'c' });
    const co = out.filter((p) => tipo(p) === 'p2p_coincident');
    expect(co).toHaveLength(1);
    const ids = co[0] as unknown as { p1_id: string; p2_id: string };
    expect([ids.p1_id, ids.p2_id].sort()).toEqual(['b', 'c']);
  });

  it('no duplica una coincidencia que ya existe', () => {
    const conUnion = attachDraggedPoint(dosLineas, 'b', { at: { x: 30, y: 5 }, pointId: 'c' });
    const otraVez = attachDraggedPoint(conUnion, 'b', { at: { x: 30, y: 5 }, pointId: 'c' });
    expect(otraVez.filter((p) => tipo(p) === 'p2p_coincident')).toHaveLength(1);
  });

  it('no une un punto consigo mismo', () => {
    const out = attachDraggedPoint(dosLineas, 'b', { at: { x: 10, y: 0 }, pointId: 'b' });
    expect(out).toBe(dosLineas);
  });

  it('soltar un punto sobre una curva lo deja apoyado en ella', () => {
    const out = attachDraggedPoint(dosLineas, 'd', {
      at: { x: 5, y: 0 }, curveId: 'l1', curveType: 'line',
    });
    const sobre = out.find((p) => tipo(p) === 'point_on_line_pl') as unknown as
      { p_id: string; l_id: string } | undefined;
    expect(sobre).toMatchObject({ p_id: 'd', l_id: 'l1' });
  });

  it('soltar al aire no inventa ninguna restricción', () => {
    expect(attachDraggedPoint(dosLineas, 'b', { at: { x: 99, y: 99 } })).toBe(dosLineas);
  });
});

describe('agarrar puntos', () => {
  const items: SketchItem[] = [
    // La posición guardada es sólo la semilla del solver.
    { id: 'p1', type: 'point', x: 0, y: 0, fixed: false },
  ] as SketchItem[];

  it('busca donde el punto se ve, no donde quedó guardado', () => {
    const resuelto = new Map([['p1', { x: 50, y: 50 }]]);
    // Sin las posiciones resueltas lo busca en el origen...
    expect(snapPoint(items, { x: 50, y: 50 }, 3)).toBeNull();
    // ...y con ellas lo encuentra donde el usuario lo está viendo.
    expect(snapPoint(items, { x: 50, y: 50 }, 3, resuelto)).toBe('p1');
    expect(snapPoint(items, { x: 0, y: 0 }, 3, resuelto)).toBeNull();
  });
});


describe('agrupado del historial', () => {
  /** Mini-réplica de la lógica de `commit`, que es donde vive el agrupado. */
  const makeHistory = () => {
    let past: string[] = [];
    let doc = 'inicial';
    let lastKey: string | undefined;
    return {
      commit(next: string, key?: string) {
        const sameGesture = key !== undefined && key === lastKey;
        lastKey = key;
        if (!sameGesture) past = [...past, doc];
        doc = next;
      },
      end() { lastKey = undefined; },
      undo() { doc = past[past.length - 1]; past = past.slice(0, -1); },
      get doc() { return doc; },
      get steps() { return past.length; },
    };
  };

  it('un arrastre entero es un solo paso', () => {
    const h = makeHistory();
    for (let i = 1; i <= 20; i++) h.commit(`pos${i}`, 'mover:p1');
    expect(h.steps).toBe(1);
    h.undo();
    expect(h.doc).toBe('inicial');
  });

  it('dos gestos distintos son dos pasos', () => {
    const h = makeHistory();
    h.commit('a', 'mover:p1');
    h.commit('b', 'mover:p1');
    h.commit('c', 'mover:p2');
    h.commit('d', 'mover:p2');
    expect(h.steps).toBe(2);
  });

  it('cerrar el gesto abre un paso nuevo aunque la clave se repita', () => {
    const h = makeHistory();
    h.commit('a', 'campo');
    h.end();
    h.commit('b', 'campo');
    expect(h.steps).toBe(2);
  });

  it('sin clave, cada cambio es su propio paso', () => {
    const h = makeHistory();
    h.commit('a');
    h.commit('b');
    h.commit('c');
    expect(h.steps).toBe(3);
  });
});

describe('trazo ortogonal', () => {
  /** Misma proyección que usa el editor con Shift apretado. */
  const orthogonal = (from: { x: number; y: number }, to: { x: number; y: number }) =>
    Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
      ? { x: to.x, y: from.y }
      : { x: from.x, y: to.y };

  it('más horizontal que vertical: fija la y', () => {
    expect(orthogonal({ x: 0, y: 0 }, { x: 50, y: 12 })).toEqual({ x: 50, y: 0 });
  });

  it('más vertical que horizontal: fija la x', () => {
    expect(orthogonal({ x: 0, y: 0 }, { x: 12, y: 50 })).toEqual({ x: 0, y: 50 });
  });

  it('en la diagonal exacta elige la horizontal', () => {
    expect(orthogonal({ x: 0, y: 0 }, { x: 30, y: 30 })).toEqual({ x: 30, y: 0 });
  });

  it('respeta el signo', () => {
    expect(orthogonal({ x: 10, y: 10 }, { x: -40, y: 5 })).toEqual({ x: -40, y: 10 });
  });
});


describe('enganche al punto medio', () => {
  const tipo = (p: SketchItem) => (p as { type: string }).type;
  const items: SketchItem[] = [
    { id: 'a', type: 'point', x: 0, y: 0, fixed: false },
    { id: 'b', type: 'point', x: 100, y: 0, fixed: false },
    { id: 'l1', type: 'line', p1_id: 'a', p2_id: 'b' },
  ] as SketchItem[];

  it('crear un punto en el medio lo ata ahí, no sólo a la línea', () => {
    const res = ensurePoint(items, { at: { x: 50, y: 0 }, midpointOf: 'l1' }, 1);
    const sim = res.primitives.find((p) => tipo(p) === 'p2p_symmetric_ppp') as unknown as
      { p1_id: string; p2_id: string; p_id: string } | undefined;
    // A y B simétricos respecto del punto nuevo = el punto es el medio.
    expect(sim).toMatchObject({ p1_id: 'a', p2_id: 'b', p_id: res.id });
    // Y no se agrega además un "sobre la línea", que sería redundante.
    expect(res.primitives.some((p) => tipo(p) === 'point_on_line_pl')).toBe(false);
  });

  it('soltar un punto arrastrado en el medio también lo ata', () => {
    const conPunto: SketchItem[] = [
      ...items, { id: 'p', type: 'point', x: 49, y: 2, fixed: false },
    ] as SketchItem[];
    const out = attachDraggedPoint(conPunto, 'p', { at: { x: 50, y: 0 }, midpointOf: 'l1' });
    const sim = out.find((p) => tipo(p) === 'p2p_symmetric_ppp') as unknown as
      { p_id: string } | undefined;
    expect(sim?.p_id).toBe('p');
  });

  it('no duplica la atadura si ya estaba', () => {
    const conPunto: SketchItem[] = [
      ...items, { id: 'p', type: 'point', x: 50, y: 0, fixed: false },
    ] as SketchItem[];
    const una = attachDraggedPoint(conPunto, 'p', { at: { x: 50, y: 0 }, midpointOf: 'l1' });
    const otra = attachDraggedPoint(una, 'p', { at: { x: 50, y: 0 }, midpointOf: 'l1' });
    expect(otra.filter((p) => tipo(p) === 'p2p_symmetric_ppp')).toHaveLength(1);
  });

  it('un punto existente en el medio se reutiliza en vez de crear otro', () => {
    const conPunto: SketchItem[] = [
      ...items, { id: 'medio', type: 'point', x: 50, y: 0, fixed: false },
    ] as SketchItem[];
    const res = ensurePoint(conPunto, { at: { x: 50, y: 0 }, pointId: 'medio' }, 1);
    expect(res.id).toBe('medio');
    expect(res.primitives).toBe(conPunto);
  });
});
