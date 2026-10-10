import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDocument } from '../store/useDocument';
import {
  curveToPolyline, solveSketch, splinePolyline,
  type SolvedSketch,
} from '../kernel/sketch';
import {
  CONSTRAINTS, addArc, addCircle, addLine, addPolygon, addRectangle, addSpline,
  applyConstraint, circularPattern, deletePrimitives, findPrim, freeSnap,
  getPoints, mirror, movePoint, offsetSelection, primType, rectangularPattern,
  attachDraggedPoint, orphanPoints, pruneOrphanPoints, snapPoint,
  type ApplyResult, type ConstraintKind, type SnapTarget, type XY,
} from '../model/sketchEdit';
import { rectFrom, selectInBox } from '../model/boxSelect';
import {
  collectDimensions, dimensionText, inferDimension, previewDimension,
  setDimensionValue, type InferredDimension,
} from '../model/dimensions';
import DimensionGlyph from './Dimensions';
import { ToolButton, type IconName } from './ToolIcons';
import { gridStep, snapToGrid } from '../model/grid';
import { trimAt } from '../model/sketchTrim';
import type { SketchFeature } from '../model/types';

/**
 * Editor 2D de bocetos.
 *
 * Es un SVG, no Three.js: para geometría plana, etiquetas de cota y glifos de
 * restricción, el SVG da líneas nítidas a cualquier zoom y el manejo del puntero
 * es directo. El boceto se edita siempre de frente al plano, así que no se
 * pierde nada por no estar en 3D.
 */

type Tool =
  | 'select' | 'line' | 'rect' | 'circle' | 'arc' | 'polygon' | 'spline'
  | 'dimension' | 'trim';

const TOOLS: { id: Tool; label: string; key: string; icon: IconName }[] = [
  { id: 'select', label: 'Seleccionar', key: 'Esc', icon: 'select' },
  { id: 'line', label: 'Línea', key: 'L', icon: 'line' },
  { id: 'spline', label: 'Curva por puntos', key: 'S', icon: 'spline' },
  { id: 'rect', label: 'Rectángulo', key: 'R', icon: 'rect' },
  { id: 'circle', label: 'Círculo', key: 'C', icon: 'circle' },
  { id: 'arc', label: 'Arco', key: 'A', icon: 'arc' },
  { id: 'polygon', label: 'Polígono', key: 'P', icon: 'polygon' },
  { id: 'dimension', label: 'Cota', key: 'D', icon: 'dimension' },
  { id: 'trim', label: 'Recortar', key: 'T', icon: 'trim' },
];

/** Lee un número del usuario, devolviendo null si cancela o no es válido. */
function askNumber(label: string, suggested: number): number | null {
  const raw = window.prompt(label, String(suggested));
  if (raw === null) return null;
  const n = Number(raw.replace(',', '.'));
  return Number.isNaN(n) ? null : n;
}

interface View { cx: number; cy: number; scale: number }

export default function SketchEditor({ sketch }: { sketch: SketchFeature }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const { patchFeature, editSketch } = useDocument();
  const canvases = useDocument((s) => s.doc.canvases);
  const parameters = useDocument((s) => s.doc.parameters);

  const [view, setView] = useState<View>({ cx: 0, cy: 0, scale: 4 });
  const [tool, setTool] = useState<Tool>('select');
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<SnapTarget[]>([]);
  const [snap, setSnap] = useState<SnapTarget | null>(null);
  const [cursor, setCursor] = useState<XY>({ x: 0, y: 0 });
  const [solved, setSolved] = useState<SolvedSketch | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [box, setBox] = useState<{ from: XY; to: XY } | null>(null);
  /**
   * La ventana también en una ref: si el pointerdown y el pointerup caen en el
   * mismo tick (un clic muy rápido), el handler todavía ve el estado viejo y se
   * perdería el clic.
   */
  const boxRef = useRef<{ from: XY; to: XY } | null>(null);
  const putBox = (next: { from: XY; to: XY } | null) => {
    boxRef.current = next;
    setBox(next);
  };
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [sides, setSides] = useState(6);
  const [snapGrid, setSnapGrid] = useState(true);
  /** Cota cuyo valor se está escribiendo. */
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  /**
   * Medida tipeada mientras se dibuja. `null` = sigue al mouse; un texto = el
   * usuario la fijó y al confirmar manda ese valor.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const [dragLabel, setDragLabel] = useState<string | null>(null);
  /** Geometría elegida con la herramienta de cota, todavía sin ubicar. */
  const [dimPicks, setDimPicks] = useState<string[]>([]);
  /** Cota nueva esperando que se escriba el valor. */
  const [newDim, setNewDim] = useState<
    { dim: InferredDimension; at: XY; value: string } | null
  >(null);

  // --- Resolver en cada cambio, para ver el efecto de las restricciones ---
  useEffect(() => {
    let alive = true;
    solveSketch(sketch, parameters)
      .then((s) => { if (alive) setSolved(s); })
      .catch((e: unknown) => {
        if (!alive) return;
        setSolved(null);
        // Un boceto que no resuelve tiene que decirlo: si no, la pantalla
        // queda en blanco sin explicación.
        setMessage(`El boceto no resuelve: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => { alive = false; };
  }, [sketch, parameters]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- Conversión pantalla <-> boceto ---
  const toScreen = useCallback(
    (p: XY) => ({
      x: size.w / 2 + (p.x - view.cx) * view.scale,
      y: size.h / 2 - (p.y - view.cy) * view.scale,
    }),
    [view, size],
  );

  const toSketch = useCallback(
    (clientX: number, clientY: number): XY => {
      const r = svgRef.current!.getBoundingClientRect();
      return {
        x: view.cx + (clientX - r.left - size.w / 2) / view.scale,
        y: view.cy - (clientY - r.top - size.h / 2) / view.scale,
      };
    },
    [view, size],
  );

  /** Radio de enganche en unidades del boceto: 10 px en pantalla. */
  const snapRadius = 10 / view.scale;

  const setPrimitives = (primitives: SketchFeature['primitives']) =>
    patchFeature(sketch.id, { primitives });

  // --- Herramientas ---
  /** Cierra la curva por puntos que se está dibujando. */
  const finishSpline = (periodic: boolean) => {
    if (pending.length >= 2) {
      setPrimitives(addSpline(sketch.primitives, pending, snapRadius, periodic));
    }
    setPending([]);
  };

  /**
   * ¿El clic engancha con geometría que ya estaba antes de empezar el trazo?
   *
   * Si es así el trazo termina ahí: es la forma natural de cerrar contra otra
   * curva sin tener que volver al primer punto.
   */
  const landsOnExisting = (target: SnapTarget) =>
    !!target.pointId && !pending.some((p) => p.pointId === target.pointId);

  const commitTool = (target: SnapTarget) => {
    const pts = [...pending, target];
    const d = (a: SnapTarget, b: SnapTarget) => Math.hypot(b.at.x - a.at.x, b.at.y - a.at.y);

    switch (tool) {
      case 'line':
        // La línea encadena: el final de una es el principio de la siguiente,
        // salvo que caiga sobre un punto que ya existía.
        if (pts.length === 2) {
          setPrimitives(addLine(sketch.primitives, pts[0], pts[1], snapRadius));
          setPending(landsOnExisting(target) ? [] : [pts[1]]);
        } else setPending(pts);
        break;

      case 'spline':
        // Volver al primer punto la cierra; caer sobre geometría que ya estaba
        // la termina abierta ahí mismo.
        if (pending.length >= 2 && d(pending[0], target) <= snapRadius) {
          finishSpline(true);
        } else if (pending.length >= 1 && landsOnExisting(target)) {
          setPrimitives(addSpline(sketch.primitives, pts, snapRadius, false));
          setPending([]);
        } else setPending(pts);
        break;

      case 'rect':
        if (pts.length === 2) {
          setPrimitives(addRectangle(sketch.primitives, pts[0].at, pts[1].at));
          setPending([]);
        } else setPending(pts);
        break;

      case 'circle':
        if (pts.length === 2) {
          setPrimitives(addCircle(sketch.primitives, pts[0], d(pts[0], pts[1]), snapRadius));
          setPending([]);
        } else setPending(pts);
        break;

      case 'arc':
        if (pts.length === 3) {
          setPrimitives(addArc(sketch.primitives, pts[0], pts[1], pts[2].at, snapRadius));
          setPending([]);
        } else setPending(pts);
        break;

      case 'polygon':
        if (pts.length === 2) {
          setPrimitives(addPolygon(sketch.primitives, pts[0].at, pts[1].at, sides));
          setPending([]);
        } else setPending(pts);
        break;
    }
  };

  // --- Herramientas de modificación ---
  const applyResult = (res: ApplyResult) => {
    if (res.error) { setMessage(res.error); return; }
    setMessage(null);
    setPrimitives(res.primitives);
    setSelected([]);
  };

  /** Último elemento del tipo pedido dentro de la selección (eje o centro). */
  const lastOfType = (type: string) =>
    [...selected].reverse().find((id) => primType(sketch.primitives, id) === type);

  const doMirror = () => {
    const axis = lastOfType('line');
    if (!axis) { setMessage('Seleccioná también la línea que hace de eje'); return; }
    applyResult(mirror(sketch.primitives, selected, axis));
  };

  const doRectPattern = () => {
    const cols = askNumber('Columnas', 3); if (cols === null) return;
    const rows = askNumber('Filas', 1); if (rows === null) return;
    const dx = askNumber('Separación en X (mm)', 20); if (dx === null) return;
    const dy = rows > 1 ? askNumber('Separación en Y (mm)', 20) : 0;
    if (dy === null) return;
    applyResult(rectangularPattern(sketch.primitives, selected, cols, rows, dx, dy));
  };

  const doCircularPattern = () => {
    const center = lastOfType('point');
    if (!center) { setMessage('Seleccioná también el punto que hace de centro'); return; }
    const count = askNumber('Cantidad de copias', 6); if (count === null) return;
    const angle = askNumber('Ángulo total (grados)', 360); if (angle === null) return;
    applyResult(circularPattern(
      sketch.primitives, selected.filter((id) => id !== center), center, count, angle,
    ));
  };

  const doOffset = () => {
    const d = askNumber('Distancia de desfase (mm, negativa hacia el otro lado)', 2);
    if (d === null) return;
    applyResult(offsetSelection(sketch.primitives, selected, d));
  };

  /**
   * Adónde va a caer el clic: a un punto existente, sobre una curva, o libre.
   * Se calcula en cada movimiento del mouse y se dibuja, así se ve antes de
   * hacer clic si el trazo va a cerrar contra algo o va a quedar suelto.
   */
  const computeSnap = (at: XY, exclude?: string): SnapTarget => {
    const pointId = snapPoint(sketch.primitives, at, snapRadius, solved?.points);
    if (pointId && pointId !== exclude) {
      const p = findPrim(sketch.primitives, pointId);
      const solvedPoint = solved?.points.get(pointId);
      return {
        at: solvedPoint ?? { x: p?.x as number, y: p?.y as number },
        pointId,
      };
    }

    if (solved) {
      let best: { at: XY; id: string; d: number } | null = null;
      for (const curve of solved.curves) {
        const poly = curveToPolyline(curve, 64);
        for (let i = 0; i < poly.length - 1; i++) {
          const proj = projectOnSegment(at, poly[i], poly[i + 1]);
          if (proj.d < snapRadius && (!best || proj.d < best.d)) {
            best = { at: proj.at, id: curve.id, d: proj.d };
          }
        }
      }
      if (best) {
        const kind = primType(sketch.primitives, best.id);
        if (kind === 'line' || kind === 'circle' || kind === 'arc') {
          return { at: best.at, curveId: best.id, curveType: kind };
        }
        // Sobre una curva por puntos sólo enganchamos la posición: PlaneGCS no
        // la conoce, así que no hay restricción que poner.
        return { at: best.at };
      }
    }

    // Último recurso: el vértice de cuadrícula más cercano. Va al final porque
    // la geometría que ya existe siempre manda sobre el fondo.
    if (snapGrid) {
      const g = snapToGrid(at, gridStep(view.scale), snapRadius);
      if (g) return { at: g, onGrid: true };
    }

    return freeSnap(at);
  };

  // --- Picking ---
  const pick = (at: XY, { points = true } = {}): string | null => {
    const pid = points ? snapPoint(sketch.primitives, at, snapRadius, solved?.points) : null;
    if (pid) return pid;
    if (!solved) return null;
    let best: string | null = null;
    let bestD = snapRadius;
    for (const curve of solved.curves) {
      const poly = curveToPolyline(curve, 64);
      for (let i = 0; i < poly.length - 1; i++) {
        const d = distToSegment(at, poly[i], poly[i + 1]);
        if (d < bestD) { bestD = d; best = curve.id; }
      }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || e.button === 2) return; // pan/menú
    const at = toSketch(e.clientX, e.clientY);

    if (tool === 'dimension') {
      const hit = pick(at);
      if (hit) {
        // Elegir: se acumulan hasta dos; el tercer clic arranca de nuevo.
        const next = dimPicks.includes(hit)
          ? dimPicks.filter((x) => x !== hit)
          : dimPicks.length >= 2 ? [hit] : [...dimPicks, hit];
        setDimPicks(next);
        setSelected(next);
        const res = inferDimension(sketch.primitives, solved!, next);
        setMessage(res.status === 'invalid' ? res.message
          : res.status === 'need-more' ? res.hint : null);
        return;
      }

      // Clic al aire: ubica la cota y abre el cuadro para escribir el valor.
      if (dimPicks.length === 0 || !solved) return;
      const res = inferDimension(sketch.primitives, solved, dimPicks);
      if (res.status !== 'ok') {
        setMessage(res.status === 'invalid' ? res.message : res.hint);
        return;
      }
      const shown = res.dim.kind === 'angle'
        ? (res.dim.value * 180) / Math.PI
        : res.dim.value;
      setNewDim({ dim: res.dim, at, value: shown.toFixed(2) });
      setMessage(null);
      return;
    }

    if (tool === 'trim') {
      // Recortar actúa sobre curvas: los puntos no se consideran.
      const hit = pick(at, { points: false });
      if (!hit) {
        setMessage('Hacé clic sobre el tramo que querés recortar');
        return;
      }
      if (!solved) return;
      const res = trimAt(sketch.primitives, solved, hit, at);
      if (res.error) setMessage(res.error);
      else { setMessage(null); setPrimitives(res.primitives); }
      return;
    }

    if (tool !== 'select') { commitTool(computeSnap(at)); return; }

    const hit = pick(at);
    if (!hit) {
      // Clic al aire: empieza una ventana de selección. Si al soltar no se
      // movió, se trata como un clic normal y limpia la selección.
      putBox({ from: at, to: at });
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    setSelected((prev) =>
      e.shiftKey
        ? (prev.includes(hit) ? prev.filter((x) => x !== hit) : [...prev, hit])
        : [hit]);
    if (primType(sketch.primitives, hit) === 'point') {
      setDragging(hit);
      (e.target as Element).setPointerCapture?.(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const at = toSketch(e.clientX, e.clientY);
    setCursor(at);
    if (e.buttons === 4 || (e.buttons === 1 && e.altKey)) {
      setView((v) => ({
        ...v,
        cx: v.cx - e.movementX / v.scale,
        cy: v.cy + e.movementY / v.scale,
      }));
      return;
    }

    if (dragLabel) {
      const dim = dimensions.find((d) => d.id === dragLabel);
      if (dim) {
        patchFeature(sketch.id, {
          labelOffsets: {
            ...sketch.labelOffsets,
            [dragLabel]: [
              dim.offset.x + e.movementX / view.scale,
              dim.offset.y - e.movementY / view.scale,
            ],
          },
        });
      }
      return;
    }

    if (dragging) {
      // Arrastrar un punto también engancha, sin contarse a sí mismo.
      const target = computeSnap(at, dragging);
      setSnap(target);
      setPrimitives(movePoint(sketch.primitives, dragging, target.at));
      return;
    }

    setSnap(tool === 'select' ? null : computeSnap(at));
    if (boxRef.current) putBox({ ...boxRef.current, to: at });
  };

  /**
   * Cierra la ventana de selección.
   *
   * Convención de CAD: arrastrar hacia la derecha selecciona sólo lo que queda
   * entero adentro; hacia la izquierda, todo lo que la ventana toque.
   */
  const finishBox = (add: boolean) => {
    const current = boxRef.current;
    if (!current) return;
    putBox(null);

    const rect = rectFrom(current.from, current.to);
    // Un arrastre más corto que el radio de enganche es en realidad un clic.
    if (rect.maxX - rect.minX < snapRadius && rect.maxY - rect.minY < snapRadius) {
      if (!add) setSelected([]);
      return;
    }

    const positions = new Map(
      getPoints(sketch.primitives).map((p) => [p.id, solved?.points.get(p.id) ?? p]),
    );
    const hits = selectInBox({
      curves: solved?.curves ?? [],
      points: positions,
      rect,
      crossing: current.to.x < current.from.x,
    });

    setSelected((prev) => (add ? [...new Set([...prev, ...hits])] : hits));
  };

  /**
   * Suelta el punto que se venía arrastrando. Si cayó sobre otro punto o sobre
   * una curva, la unión queda registrada como restricción.
   */
  const releaseDrag = () => {
    if (dragging && snap) {
      const out = attachDraggedPoint(sketch.primitives, dragging, snap);
      if (out !== sketch.primitives) {
        setPrimitives(out);
        setMessage(snap.pointId ? 'Puntos unidos' : 'Punto apoyado en la curva');
      }
    }
    setDragging(null);
    setSnap(null);
  };

  const onWheel = (e: React.WheelEvent) => {
    const at = toSketch(e.clientX, e.clientY);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setView((v) => ({
      scale: Math.max(0.05, Math.min(400, v.scale * factor)),
      // Zoom centrado en el cursor.
      cx: at.x - (at.x - v.cx) / factor,
      cy: at.y - (at.y - v.cy) / factor,
    }));
  };

  /** Crea la cota con el valor escrito y la deja donde se la ubicó. */
  const commitNewDim = () => {
    if (!newDim) return;
    const v = Number(newDim.value.replace(',', '.'));
    if (Number.isNaN(v) || v === 0) { setMessage('Valor no válido'); return; }

    const res = applyConstraint(sketch.primitives, newDim.dim.kind, newDim.dim.ids, v);
    if (res.error) { setMessage(res.error); return; }

    // La etiqueta queda donde se hizo clic, no en su lugar por defecto.
    const created = res.primitives[res.primitives.length - 1] as { id: string };
    patchFeature(sketch.id, {
      primitives: res.primitives,
      labelOffsets: {
        ...sketch.labelOffsets,
        [created.id]: [
          newDim.at.x - newDim.dim.anchor.x,
          newDim.at.y - newDim.dim.anchor.y,
        ],
      },
    });
    setNewDim(null);
    setDimPicks([]);
    setSelected([]);
    setMessage(null);
  };

  // --- Restricciones ---
  const selectedTypes = selected
    .map((id) => primType(sketch.primitives, id) ?? '')
    .filter(Boolean);

  // Las cotas no pasan por acá: las crea la herramienta de cota.
  const runConstraint = (kind: ConstraintKind) => {
    const res = applyConstraint(sketch.primitives, kind, selected);
    if (res.error) { setMessage(res.error); return; }
    setMessage(null);
    setPrimitives(res.primitives);
    setSelected([]);
  };

  // --- Atajos ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (e.key === 'Enter') {
        if (tool === 'spline') finishSpline(false);
        else setPending([]);
      }
      else if (e.key === 'Escape') {
        setTool('select'); setPending([]); setSelected([]); setSnap(null);
        putBox(null); setDimPicks([]); setNewDim(null); setDraft(null);
      }
      else if (k === 'l') setTool('line');
      else if (k === 'r') setTool('rect');
      else if (k === 'c') setTool('circle');
      else if (k === 'a') setTool('arc');
      else if (k === 'p') setTool('polygon');
      else if (k === 's') setTool('spline');
      else if (k === 't') setTool('trim');
      else if (k === 'g') setSnapGrid((v) => !v);
      else if (k === 'd') setTool('dimension');
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selected.length) {
          setPrimitives(deletePrimitives(sketch.primitives, selected));
          setSelected([]);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // --- Dibujo ---
  const gridLines = useMemo(() => buildGrid(view, size), [view, size]);
  const points = getPoints(sketch.primitives);
  const orphans = useMemo(() => orphanPoints(sketch.primitives), [sketch.primitives]);
  /**
   * Cota que se está por colocar, dibujada bajo el cursor.
   *
   * Verla antes de hacer clic es lo que permite ubicarla donde uno quiere y
   * confirmar que está midiendo lo que cree.
   */
  const previewDim = useMemo(() => {
    if (tool !== 'dimension' || newDim || !solved || dimPicks.length === 0) return null;
    const res = inferDimension(sketch.primitives, solved, dimPicks);
    return res.status === 'ok' ? previewDimension(res.dim, cursor) : null;
  }, [tool, newDim, solved, dimPicks, sketch.primitives, cursor]);

  const dimensions = useMemo(
    () => (solved ? collectDimensions(sketch.primitives, solved, sketch.labelOffsets) : []),
    [sketch.primitives, sketch.labelOffsets, solved],
  );

  /** Posición por defecto del texto de una cota, antes de correrlo. */
  const labelAt = (dim: (typeof dimensions)[number]) => {
    const a = toScreen(dim.a), b = toScreen(dim.b);
    const base = dim.kind === 'angle' && dim.vertex
      ? toScreen(dim.vertex)
      : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // El empujón por defecto separa la cota de la geometría; si el usuario la
    // ubicó él, se respeta su posición tal cual.
    const placed = dim.offset.x !== 0 || dim.offset.y !== 0;
    const push = placed
      ? { x: 0, y: 0 }
      : dim.kind === 'distance'
        ? (() => {
          const dx = b.x - a.x, dy = b.y - a.y;
          const l = Math.hypot(dx, dy) || 1;
          return { x: (-dy / l) * 26, y: (dx / l) * 26 };
        })()
        : dim.kind === 'angle'
          ? { x: 34, y: -22 }
          : { x: 0, y: -14 };
    return {
      x: base.x + push.x + dim.offset.x * view.scale,
      y: base.y + push.y - dim.offset.y * view.scale,
    };
  };
  // Los lienzos viven sobre los planos del origen; sólo se muestran si el
  // boceto se apoya en el mismo.
  const planeCanvases = canvases.filter(
    (c) => c.visible && sketch.plane.kind === 'base' && c.plane === sketch.plane.plane,
  );

  const preview = buildPreview(tool, pending.map((p) => p.at), snap?.at ?? cursor, sides);

  /**
   * Medida de lo que se está dibujando ahora mismo, para poder escribirla.
   *
   * Sólo en línea y círculo: son las dos donde uno sabe la medida de antemano
   * y escribirla es más rápido que dibujar y después acotar.
   */
  const liveMeasure = (() => {
    if (pending.length !== 1 || newDim) return null;
    const from = pending[0].at;
    const to = snap?.at ?? cursor;
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    if (tool === 'line') return { label: 'Largo', value: d, from, to };
    if (tool === 'circle') return { label: 'Diámetro', value: d * 2, from, to };
    return null;
  })();

  /** Crea la geometría con la medida tipeada y la deja acotada. */
  const commitDraft = () => {
    if (!liveMeasure || draft === null) return;
    const v = Number(draft.replace(',', '.'));
    if (Number.isNaN(v) || v <= 0) { setMessage('Medida no válida'); return; }

    const { from, to } = liveMeasure;
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) { setMessage('Movè el mouse para marcar la dirección'); return; }

    if (tool === 'line') {
      // El punto final va a la distancia pedida, en la dirección del cursor.
      const end = { x: from.x + (dx / len) * v, y: from.y + (dy / len) * v };
      let out = addLine(sketch.primitives, pending[0], freeSnap(end), snapRadius);
      const line = [...out].reverse().find((x) => (x as { type: string }).type === 'line') as
        { id: string; p1_id: string; p2_id: string } | undefined;
      if (line) {
        const res = applyConstraint(out, 'distance', [line.p1_id, line.p2_id], v);
        if (!res.error) out = res.primitives;
      }
      setPrimitives(out);
      setPending([freeSnap(end)]);
    } else {
      let out = addCircle(sketch.primitives, pending[0], v / 2, snapRadius);
      const circle = [...out].reverse().find((x) => (x as { type: string }).type === 'circle') as
        { id: string } | undefined;
      if (circle) {
        const res = applyConstraint(out, 'diameter', [circle.id], v);
        if (!res.error) out = res.primitives;
      }
      setPrimitives(out);
      setPending([]);
    }
    setDraft(null);
    setMessage(null);
  };

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Barra de herramientas del boceto */}
      <div className="ribbon" style={{ flexWrap: 'wrap' }}>
        <div className="ribbon-group">
          <div className="row">
            {TOOLS.map((t) => (
              <ToolButton
                key={t.id}
                icon={t.icon}
                label={t.label}
                className={tool === t.id ? 'active' : ''}
                data-testid={`tool-${t.id}`}
                title={`${t.label} (${t.key})`}
                onClick={() => {
                  setTool(t.id);
                  setPending([]);
                  setDimPicks([]);
                  setNewDim(null);
                  setDraft(null);
                }}
              />
            ))}
            <ToolButton
              icon="grid"
              label="Cuadrícula"
              className={snapGrid ? 'active' : ''}
              data-testid="toggle-grid-snap"
              title="Enganchar a los vértices de la cuadrícula (G)"
              onClick={() => setSnapGrid((v) => !v)}
            />
            {tool === 'polygon' && (
              <input
                type="number" min={3} max={64} value={sides} style={{ width: 56 }}
                title="Cantidad de lados"
                onChange={(e) => setSides(Math.max(3, Math.min(64, Number(e.target.value) || 3)))}
              />
            )}
          </div>
          <div className="label">Crear</div>
        </div>

        <div className="ribbon-group">
          <div className="row" style={{ flexWrap: 'wrap', maxWidth: 560 }}>
            {CONSTRAINTS.map((c) => (
              <ToolButton
                key={c.kind}
                icon={c.kind as IconName}
                label={c.label}
                data-testid={`constraint-${c.kind}`}
                disabled={!c.accepts(selectedTypes)}
                title={c.label}
                onClick={() => runConstraint(c.kind)}
              />
            ))}
          </div>
          <div className="label">Restricciones</div>
        </div>

        <div className="ribbon-group">
          <div className="row">
            <ToolButton
              icon="symmetric" label="Simetría"
              data-testid="mod-mirror" disabled={selected.length < 2} onClick={doMirror}
              title="Seleccioná la geometría y, al final, la línea que hace de eje"
            />
            <ToolButton
              icon="pattern_rect" label="Patrón rect."
              data-testid="mod-rect-pattern" disabled={selected.length === 0} onClick={doRectPattern}
            />
            <ToolButton
              icon="pattern_circ" label="Patrón circ."
              data-testid="mod-circ-pattern" disabled={selected.length < 2} onClick={doCircularPattern}
              title="Seleccioná la geometría y, al final, el punto que hace de centro"
            />
            <ToolButton
              icon="offset" label="Desfase"
              data-testid="mod-offset" disabled={selected.length === 0} onClick={doOffset}
            />
            <ToolButton
              icon="prune"
              label={`Limpiar sueltos${orphans.length > 0 ? ` (${orphans.length})` : ''}`}
              data-testid="mod-prune" disabled={orphans.length === 0}
              title="Borra los puntos que ya no sostienen ninguna curva"
              onClick={() => {
                setPrimitives(pruneOrphanPoints(sketch.primitives));
                setSelected([]);
                setMessage(null);
              }}
            />
            <ToolButton
              icon="trash" label="Borrar"
              data-testid="mod-delete" disabled={selected.length === 0}
              onClick={() => {
                setPrimitives(deletePrimitives(sketch.primitives, selected));
                setSelected([]);
              }}
            />
          </div>
          <div className="label">Modificar</div>
        </div>

        <div className="ribbon-group">
          <div className="row">
            <ToolButton
              icon="check" label="Terminar boceto"
              className="active" onClick={() => editSketch(null)}
            />
          </div>
          <div className="label">{sketch.name}</div>
        </div>
      </div>

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <svg
          ref={svgRef}
          data-testid="sketch-canvas"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', background: 'var(--bg)', cursor: tool === 'select' ? 'default' : 'crosshair' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => {
            finishBox(e.shiftKey);
            releaseDrag();
            setDragLabel(null);
          }}
          onDoubleClick={() => {
            if (tool === 'spline') finishSpline(false);
            else if (tool === 'line') setPending([]);
          }}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
        >
          {/* Lienzos de referencia del mismo plano */}
          {planeCanvases.map((c) => {
            const tl = toScreen({ x: c.center[0] - c.width / 2, y: c.center[1] });
            return (
              <image
                key={c.id} href={c.src} x={tl.x} y={0} width={c.width * view.scale}
                opacity={c.opacity} preserveAspectRatio="xMidYMid meet"
                style={{ pointerEvents: 'none' }}
                y-origin={tl.y}
                transform={`translate(0, ${tl.y - (c.width * view.scale) / 2})`}
              />
            );
          })}

          {/* Grilla y ejes */}
          <g stroke="var(--line)" strokeWidth={1} opacity={0.5}>
            {gridLines.map((l, i) => (
              <line key={i} x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]} />
            ))}
          </g>
          <line x1={0} y1={toScreen({ x: 0, y: 0 }).y} x2={size.w} y2={toScreen({ x: 0, y: 0 }).y} stroke="#8a4b4b" />
          <line x1={toScreen({ x: 0, y: 0 }).x} y1={0} x2={toScreen({ x: 0, y: 0 }).x} y2={size.h} stroke="#4b8a5a" />

          {/* Geometría resuelta */}
          {solved?.curves.map((curve) => (
            <polyline
              key={curve.id}
              points={curveToPolyline(curve, 64).map((p) => {
                const s = toScreen(p);
                return `${s.x},${s.y}`;
              }).join(' ')}
              fill="none"
              strokeWidth={selected.includes(curve.id) ? 3 : 2}
              stroke={selected.includes(curve.id) ? 'var(--accent)' : (solved.underConstrained ? '#9aa7b4' : '#dde3ea')}
            />
          ))}

          {/* Vista previa de la herramienta activa */}
          {preview && (
            <polyline
              points={preview.map((p) => { const s = toScreen(p); return `${s.x},${s.y}`; }).join(' ')}
              fill="none" stroke="var(--accent)" strokeDasharray="4 3" strokeWidth={1.5}
            />
          )}

          {/* Cotas */}
          {dimensions.map((dim) => (
            <DimensionGlyph
              key={dim.id}
              dim={dim}
              a={toScreen(dim.a)}
              b={toScreen(dim.b)}
              vertex={dim.vertex && toScreen(dim.vertex)}
              label={labelAt(dim)}
              selected={selected.includes(dim.id)}
              onPick={(e) => {
                e.stopPropagation();
                setSelected((prev) =>
                  e.shiftKey
                    ? (prev.includes(dim.id) ? prev.filter((x) => x !== dim.id) : [...prev, dim.id])
                    : [dim.id]);
                setDragLabel(dim.id);
                (e.target as Element).setPointerCapture?.(e.pointerId);
              }}
              onEdit={() => setEditing({ id: dim.id, value: String(dim.value) })}
            />
          ))}

          {/* Cota en curso, siguiendo al cursor */}
          {previewDim && (
            <g opacity={0.9}>
              <DimensionGlyph
                dim={previewDim}
                a={toScreen(previewDim.a)}
                b={toScreen(previewDim.b)}
                vertex={previewDim.vertex && toScreen(previewDim.vertex)}
                label={toScreen(cursor)}
                selected
                preview
                onPick={() => {}}
                onEdit={() => {}}
              />
            </g>
          )}

          {/* Ventana de selección */}
          {box && (() => {
            const a = toScreen(box.from), b = toScreen(box.to);
            const crossing = box.to.x < box.from.x;
            return (
              <rect
                data-testid="selection-box"
                data-mode={crossing ? 'crossing' : 'window'}
                x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)}
                width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)}
                fill={crossing ? 'rgba(126,231,135,0.10)' : 'rgba(74,163,255,0.10)'}
                stroke={crossing ? '#7ee787' : 'var(--accent)'}
                strokeWidth={1}
                strokeDasharray={crossing ? '5 3' : undefined}
                style={{ pointerEvents: 'none' }}
              />
            );
          })()}

          {/* Marcador de enganche: dice adónde va a caer el clic */}
          {snap && (() => {
            const p = toScreen(snap.at);
            const kind = snap.pointId ? 'point' : snap.curveId ? 'curve' : snap.onGrid ? 'grid' : 'free';
            const color = { point: '#ffd45e', curve: '#7ee787', grid: '#9bb4ff', free: '#8d99a6' }[kind];
            return (
              <g data-testid="snap-marker" data-snap={kind} style={{ pointerEvents: 'none' }}>
                {snap.pointId ? (
                  // Coincidente: cuadro sobre el punto que se va a reutilizar.
                  <rect
                    x={p.x - 7} y={p.y - 7} width={14} height={14}
                    fill="none" stroke={color} strokeWidth={2}
                  />
                ) : snap.curveId ? (
                  // Sobre la curva: cruz en aspa.
                  <g stroke={color} strokeWidth={2}>
                    <line x1={p.x - 6} y1={p.y - 6} x2={p.x + 6} y2={p.y + 6} />
                    <line x1={p.x - 6} y1={p.y + 6} x2={p.x + 6} y2={p.y - 6} />
                  </g>
                ) : snap.onGrid ? (
                  // Vértice de la cuadrícula: rombo con una cruz adentro.
                  <g stroke={color} strokeWidth={1.6} fill="none">
                    <path d={`M ${p.x} ${p.y - 8} L ${p.x + 8} ${p.y} L ${p.x} ${p.y + 8} L ${p.x - 8} ${p.y} Z`} />
                    <line x1={p.x - 3} y1={p.y} x2={p.x + 3} y2={p.y} />
                    <line x1={p.x} y1={p.y - 3} x2={p.x} y2={p.y + 3} />
                  </g>
                ) : (
                  <circle cx={p.x} cy={p.y} r={3} fill="none" stroke={color} strokeWidth={1.5} />
                )}
              </g>
            );
          })()}

          {/* Puntos ya marcados de la curva en curso */}
          {pending.map((pt, i) => {
            const p = toScreen(pt.at);
            return (
              <circle key={i} cx={p.x} cy={p.y} r={3} fill="var(--accent)" stroke="#11151a" />
            );
          })}

          {/* Puntos */}
          {points.map((p) => {
            const s = toScreen(solved?.points.get(p.id) ?? p);
            const isSel = selected.includes(p.id);
            // Un punto suelto se marca en rojo: no sostiene ninguna curva.
            const isOrphan = orphans.includes(p.id);
            return (
              <rect
                key={p.id}
                data-testid={`pt-${p.id}`}
                data-orphan={isOrphan || undefined}
                x={s.x - 3.5} y={s.y - 3.5} width={7} height={7}
                fill={isSel ? 'var(--accent)' : isOrphan ? '#e05c5c' : p.fixed ? '#e0a33c' : '#cfd6de'}
                stroke="#11151a"
              />
            );
          })}
        </svg>

        {/* Medida de lo que se está dibujando: se puede escribir directamente */}
        {liveMeasure && (() => {
          const p = toScreen(liveMeasure.to);
          return (
            <div style={{ position: 'absolute', left: p.x + 16, top: p.y + 14, zIndex: 5 }}>
              <label className="hint" style={{ display: 'block', marginBottom: 2 }}>
                {liveMeasure.label}
              </label>
              <input
                data-testid="live-measure"
                autoFocus
                value={draft ?? liveMeasure.value.toFixed(2)}
                style={{ width: 90, textAlign: 'center' }}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitDraft();
                  else if (e.key === 'Escape') { setDraft(null); setPending([]); }
                  e.stopPropagation();
                }}
              />
            </div>
          );
        })()}

        {/* Valor de una cota recién ubicada */}
        {newDim && (() => {
          const p = toScreen(newDim.at);
          return (
            <input
              data-testid="new-dim-input"
              autoFocus
              onFocus={(e) => e.target.select()}
              title={dimensionText(newDim.dim.kind, newDim.dim.value)}
              value={newDim.value}
              style={{
                position: 'absolute', left: p.x - 45, top: p.y - 12,
                width: 90, textAlign: 'center', zIndex: 5,
              }}
              onChange={(e) => setNewDim({ ...newDim, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitNewDim();
                else if (e.key === 'Escape') { setNewDim(null); setDimPicks([]); }
                e.stopPropagation();
              }}
            />
          );
        })()}

        {/* Editor del valor de una cota, encima del lienzo */}
        {editing && (() => {
          const dim = dimensions.find((d) => d.id === editing.id);
          if (!dim) return null;
          const p = labelAt(dim);
          const commit = () => {
            const v = Number(editing.value.replace(',', '.'));
            if (!Number.isNaN(v) && v !== 0) {
              // El ángulo se escribe en grados pero se guarda en radianes.
              const stored = dim.kind === 'angle' ? (v * Math.PI) / 180 : v;
              setPrimitives(setDimensionValue(sketch.primitives, dim.id, stored));
            }
            setEditing(null);
          };
          return (
            <input
              data-testid="dim-input"
              autoFocus
              value={editing.value}
              style={{
                position: 'absolute', left: p.x - 40, top: p.y - 12,
                width: 80, textAlign: 'center', zIndex: 5,
              }}
              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                else if (e.key === 'Escape') setEditing(null);
                e.stopPropagation();
              }}
            />
          );
        })()}

        <div className="view-badge" data-testid="sketch-info">
          <div>
            <b>{(snap?.at ?? cursor).x.toFixed(2)}</b>,{' '}
            <b>{(snap?.at ?? cursor).y.toFixed(2)}</b> mm
          </div>
          <div>
            {solved
              ? solved.underConstrained
                ? 'Sin restringir del todo'
                : 'Totalmente restringido'
              : 'resolviendo…'}
            {solved && solved.conflicting.length > 0 && ' · conflictos'}
          </div>
          <div>{selected.length} seleccionado(s)</div>
          {orphans.length > 0 && (
            <div style={{ color: 'var(--danger)' }}>
              {orphans.length} punto(s) suelto(s)
            </div>
          )}
          {box && (
            <div style={{ color: box.to.x < box.from.x ? '#7ee787' : 'var(--accent)' }}>
              {box.to.x < box.from.x
                ? 'ventana: todo lo que toque'
                : 'ventana: sólo lo que quede entero adentro'}
            </div>
          )}
          {snap?.pointId && <div style={{ color: '#ffd45e' }}>coincide con un punto existente</div>}
          {snap?.curveId && <div style={{ color: '#7ee787' }}>queda sobre la curva</div>}
          {snap?.onGrid && <div style={{ color: '#9bb4ff' }}>vértice de la cuadrícula</div>}
          {tool === 'dimension' && !newDim && (
            <div style={{ color: '#c8a24a' }}>
              {dimPicks.length === 0
                ? 'Elegí una línea, un círculo, un arco, dos puntos o dos líneas'
                : 'Hacé clic donde querés ubicar la cota'}
            </div>
          )}
          {dimensions.length > 0 && (
            <div>Doble clic en una cota para cambiarla · arrastrala para moverla</div>
          )}
          {tool === 'spline' && (
            <div>
              Enter o doble clic para terminar · enganchá con otra curva para
              cerrar contra ella · volvé al primer punto para cerrarla sobre sí misma
            </div>
          )}
          {message && <div style={{ color: 'var(--danger)' }}>{message}</div>}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------

/** Punto más cercano del segmento y su distancia. */
function projectOnSegment(p: XY, a: XY, b: XY): { at: XY; d: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const at = { x: a.x + t * dx, y: a.y + t * dy };
  return { at, d: Math.hypot(p.x - at.x, p.y - at.y) };
}

function distToSegment(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Líneas de grilla con paso "redondo" según el zoom. */
function buildGrid(view: View, size: { w: number; h: number }): number[][] {
  const step = gridStep(view.scale);

  const halfW = size.w / 2 / view.scale;
  const halfH = size.h / 2 / view.scale;
  const out: number[][] = [];
  const x0 = Math.ceil((view.cx - halfW) / step) * step;
  for (let x = x0; x < view.cx + halfW; x += step) {
    const sx = size.w / 2 + (x - view.cx) * view.scale;
    out.push([sx, 0, sx, size.h]);
  }
  const y0 = Math.ceil((view.cy - halfH) / step) * step;
  for (let y = y0; y < view.cy + halfH; y += step) {
    const sy = size.h / 2 - (y - view.cy) * view.scale;
    out.push([0, sy, size.w, sy]);
  }
  return out;
}

function buildPreview(tool: Tool, pending: XY[], cursor: XY, sides = 6): XY[] | null {
  if (pending.length === 0) return null;
  const a = pending[0];
  switch (tool) {
    case 'line': return [a, cursor];
    case 'rect': return [a, { x: cursor.x, y: a.y }, cursor, { x: a.x, y: cursor.y }, a];
    case 'circle': {
      const r = Math.hypot(cursor.x - a.x, cursor.y - a.y);
      return Array.from({ length: 49 }, (_, i) => ({
        x: a.x + r * Math.cos((i / 48) * 2 * Math.PI),
        y: a.y + r * Math.sin((i / 48) * 2 * Math.PI),
      }));
    }
    case 'arc': {
      if (pending.length === 1) return [a, cursor];
      const r = Math.hypot(pending[1].x - a.x, pending[1].y - a.y);
      const a0 = Math.atan2(pending[1].y - a.y, pending[1].x - a.x);
      let a1 = Math.atan2(cursor.y - a.y, cursor.x - a.x);
      while (a1 <= a0) a1 += 2 * Math.PI;
      return Array.from({ length: 33 }, (_, i) => ({
        x: a.x + r * Math.cos(a0 + ((a1 - a0) * i) / 32),
        y: a.y + r * Math.sin(a0 + ((a1 - a0) * i) / 32),
      }));
    }
    case 'spline': {
      // Se dibuja la curva real que va a quedar, no la poligonal.
      const through = [...pending, cursor];
      return through.length >= 3 ? splinePolyline(through, false) : through;
    }
    case 'polygon': {
      const r = Math.hypot(cursor.x - a.x, cursor.y - a.y);
      const a0 = Math.atan2(cursor.y - a.y, cursor.x - a.x);
      return Array.from({ length: sides + 1 }, (_, i) => ({
        x: a.x + r * Math.cos(a0 + (i / sides) * 2 * Math.PI),
        y: a.y + r * Math.sin(a0 + (i / sides) * 2 * Math.PI),
      }));
    }
    default: return null;
  }
}

