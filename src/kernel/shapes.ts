/**
 * Operaciones de modelado sobre OCCT.
 *
 * Todas reciben la instancia `oc` como primer argumento para que el mismo
 * código corra en el navegador y en los scripts de prueba de Node.
 */
import type {
  OpenCascadeInstance, TopoDS_Shape, TopoDS_Face, TopoDS_Edge, TopoDS_Wire,
  TopAbs_ShapeEnum, ChFi3d_FilletShape,
} from 'opencascade.js';
import type { BooleanOp, EdgeSelection, PlaneId } from '../model/types';
import type { Loop, P2, Region, SolvedCurve } from './sketch';

/**
 * Los tipados generados de opencascade.js declaran los parámetros de enum con
 * el tipo del contenedor en vez del tipo del miembro, así que pasar un miembro
 * no compila. Este cast puentea esa rareza en un solo lugar.
 */
const enumVal = <T>(v: unknown): T => v as T;

// --------------------------------------------------------------------------
// Planos de boceto
// --------------------------------------------------------------------------

/**
 * Base de un plano de boceto: `o` es el origen, `u` y `v` los ejes locales y
 * `n` la normal. Mapeamos los puntos 2D a 3D a mano en vez de usar gp_Trsf: es
 * más explícito y evita confusiones de dirección en las transformaciones.
 */
export interface PlaneBasis {
  o: [number, number, number];
  u: [number, number, number];
  v: [number, number, number];
  n: [number, number, number];
}

export const PLANES: Record<PlaneId, PlaneBasis> = {
  XY: { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
  XZ: { o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] },
  YZ: { o: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0] },
};

export const to3d = (b: PlaneBasis, p: P2): [number, number, number] => [
  b.o[0] + b.u[0] * p.x + b.v[0] * p.y,
  b.o[1] + b.u[1] * p.x + b.v[1] * p.y,
  b.o[2] + b.u[2] * p.x + b.v[2] * p.y,
];

/** Mueve un plano `distance` mm a lo largo de su normal. */
export const offsetPlane = (b: PlaneBasis, distance: number): PlaneBasis => ({
  ...b,
  o: [
    b.o[0] + b.n[0] * distance,
    b.o[1] + b.n[1] * distance,
    b.o[2] + b.n[2] * distance,
  ],
});

/** Da vuelta la normal del plano, manteniéndolo dextrógiro. */
export const flipPlane = (b: PlaneBasis): PlaneBasis => ({
  o: b.o,
  u: b.u,
  v: [-b.v[0], -b.v[1], -b.v[2]],
  n: [-b.n[0], -b.n[1], -b.n[2]],
});

// --------------------------------------------------------------------------
// Perfil -> cara
// --------------------------------------------------------------------------

function curveToEdge(
  oc: OpenCascadeInstance, b: PlaneBasis, curve: SolvedCurve,
): TopoDS_Edge {
  const P = (p: P2) => new oc.gp_Pnt_3(...to3d(b, p));
  const normal = new oc.gp_Dir_4(...b.n);
  const uDir = new oc.gp_Dir_4(...b.u);

  if (curve.kind === 'line') {
    return new oc.BRepBuilderAPI_MakeEdge_3(P(curve.a), P(curve.b)).Edge();
  }

  if (curve.kind === 'spline') {
    // B-spline que pasa por los puntos marcados (el ajuste da un error del
    // orden de 1e-13, así que a efectos prácticos los interpola).
    const pts = curve.periodic ? [...curve.through, curve.through[0]] : curve.through;
    const arr = new oc.TColgp_Array1OfPnt_2(1, pts.length);
    pts.forEach((pt, i) => arr.SetValue(i + 1, P(pt)));
    const fit = new oc.GeomAPI_PointsToBSpline_2(
      arr, 3, 8, enumVal(2) /* GeomAbs_C2 */, 1e-5,
    );
    if (!fit.IsDone()) throw new Error('No pude construir la curva por puntos');
    return new oc.BRepBuilderAPI_MakeEdge_24(
      new oc.Handle_Geom_Curve_2(fit.Curve().get()),
    ).Edge();
  }

  // El eje X del gp_Ax2 es `u`, que es justo el ángulo 0 del boceto.
  const ax2 = new oc.gp_Ax2_2(P(curve.c), normal, uDir);
  const circ = new oc.gp_Circ_2(ax2, curve.r);
  if (curve.kind === 'circle') {
    return new oc.BRepBuilderAPI_MakeEdge_8(circ).Edge();
  }
  let { a0, a1 } = curve;
  while (a1 <= a0) a1 += 2 * Math.PI;
  return new oc.BRepBuilderAPI_MakeEdge_9(circ, a0, a1).Edge();
}

export function loopToWire(oc: OpenCascadeInstance, b: PlaneBasis, loop: Loop): TopoDS_Wire {
  const mw = new oc.BRepBuilderAPI_MakeWire_1();
  for (const seg of loop.segments) mw.Add_1(curveToEdge(oc, b, seg.curve));
  return mw.Wire();
}

/** Contorno más agujeros -> una cara plana con huecos. */
export function regionToFace(
  oc: OpenCascadeInstance, b: PlaneBasis, region: Region,
): TopoDS_Face {
  const mk = new oc.BRepBuilderAPI_MakeFace_15(loopToWire(oc, b, region.outer), false);
  for (const hole of region.holes) {
    const w = loopToWire(oc, b, hole);
    // Un agujero tiene que recorrer el contrario que el contorno.
    mk.Add(hole.signedArea * region.outer.signedArea > 0 ? oc.TopoDS.Wire_1(w.Reversed()) : w);
  }
  return mk.Face();
}

// --------------------------------------------------------------------------
// Operaciones
// --------------------------------------------------------------------------

/**
 * Caras planas del sólido, en orden determinista.
 *
 * El criterio es el mismo que para las aristas (ordenar por el centroide, no
 * por el recorrido de la topología) para que un boceto apoyado en la cara n.º 3
 * siga apoyado ahí después de reconstruir.
 */
export function planarFaces(oc: OpenCascadeInstance, shape: TopoDS_Shape): PlaneBasis[] {
  const out: { basis: PlaneBasis; key: [number, number, number] }[] = [];
  const seen: TopoDS_Face[] = [];

  for (
    const exp = new oc.TopExp_Explorer_2(
      shape,
      enumVal<TopAbs_ShapeEnum>(oc.TopAbs_ShapeEnum.TopAbs_FACE),
      enumVal<TopAbs_ShapeEnum>(oc.TopAbs_ShapeEnum.TopAbs_SHAPE),
    );
    exp.More(); exp.Next()
  ) {
    const face = oc.TopoDS.Face_1(exp.Current());
    if (seen.some((prev) => prev.IsSame(face))) continue;
    seen.push(face);

    const ad = new oc.BRepAdaptor_Surface_2(face, true);
    if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) continue;

    const pln = ad.Plane();
    const ax = pln.Position();
    const dir = ax.Direction();
    const xd = ax.XDirection();
    const yd = ax.YDirection();

    // El origen va en el centro de la cara, no en el del plano infinito: así
    // el boceto arranca donde uno está mirando.
    const props = new oc.GProp_GProps_1();
    oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
    const c = props.CentreOfMass();

    // Una cara REVERSED tiene la normal del material al revés.
    const sign = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED ? -1 : 1;
    const n: [number, number, number] = [dir.X() * sign, dir.Y() * sign, dir.Z() * sign];
    const v: [number, number, number] = [yd.X() * sign, yd.Y() * sign, yd.Z() * sign];

    out.push({
      basis: { o: [c.X(), c.Y(), c.Z()], u: [xd.X(), xd.Y(), xd.Z()], v, n },
      key: [c.X(), c.Y(), c.Z()],
    });
  }

  const r = (x: number) => Math.round(x * 1e6);
  out.sort((a, b) =>
    r(a.key[0]) - r(b.key[0]) || r(a.key[1]) - r(b.key[1]) || r(a.key[2]) - r(b.key[2]));
  return out.map((f) => f.basis);
}

export function extrude(
  oc: OpenCascadeInstance, face: TopoDS_Face, b: PlaneBasis,
  distance: number, symmetric = false,
): TopoDS_Shape {
  const d = symmetric ? distance / 2 : distance;
  const vec = new oc.gp_Vec_4(b.n[0] * d, b.n[1] * d, b.n[2] * d);
  const up = new oc.BRepPrimAPI_MakePrism_1(face, vec, false, true).Shape();
  if (!symmetric) return up;
  const down = new oc.BRepPrimAPI_MakePrism_1(
    face, new oc.gp_Vec_4(-vec.X(), -vec.Y(), -vec.Z()), false, true,
  ).Shape();
  return boolOp(oc, up, down, 'join');
}

export function revolve(
  oc: OpenCascadeInstance, face: TopoDS_Face, b: PlaneBasis,
  axisOrigin: P2, axisDir: P2, angleDeg: number,
): TopoDS_Shape {
  const o = to3d(b, axisOrigin);
  const d = to3d(b, axisDir);
  if (Math.hypot(d[0], d[1], d[2]) < 1e-9) {
    throw new Error('El eje de revolución no puede tener longitud cero');
  }
  const axis = new oc.gp_Ax1_2(new oc.gp_Pnt_3(...o), new oc.gp_Dir_4(...d));
  const angle = Math.min(Math.max(angleDeg, 0.001), 360) * (Math.PI / 180);
  return new oc.BRepPrimAPI_MakeRevol_1(face, axis, angle, true).Shape();
}

export function boolOp(
  oc: OpenCascadeInstance, a: TopoDS_Shape, b: TopoDS_Shape, op: BooleanOp,
): TopoDS_Shape {
  const range = new oc.Message_ProgressRange_1();
  switch (op) {
    case 'join': return new oc.BRepAlgoAPI_Fuse_3(a, b, range).Shape();
    case 'cut': return new oc.BRepAlgoAPI_Cut_3(a, b, range).Shape();
    case 'intersect': return new oc.BRepAlgoAPI_Common_3(a, b, range).Shape();
    default: return b;
  }
}

// --------------------------------------------------------------------------
// Aristas
// --------------------------------------------------------------------------

export interface EdgeInfo {
  edge: TopoDS_Edge;
  /** Dirección unitaria, sólo si la arista es recta. */
  dir: [number, number, number] | null;
  mid: [number, number, number];
}

/**
 * Aristas únicas, en orden determinista.
 *
 * `TopExp_Explorer` devuelve cada arista una vez por cara adyacente, así que
 * hay que deduplicar con `IsSame` (`TopTools_IndexedMapOfShape` no está
 * expuesto en este build). El orden sale del punto medio, no del recorrido,
 * para que una selección por índice sobreviva a reconstrucciones.
 */
export function orderedEdges(oc: OpenCascadeInstance, shape: TopoDS_Shape): EdgeInfo[] {
  const seen: TopoDS_Edge[] = [];
  const out: EdgeInfo[] = [];

  for (
    const e = new oc.TopExp_Explorer_2(
      shape,
      enumVal<TopAbs_ShapeEnum>(oc.TopAbs_ShapeEnum.TopAbs_EDGE),
      enumVal<TopAbs_ShapeEnum>(oc.TopAbs_ShapeEnum.TopAbs_SHAPE),
    );
    e.More(); e.Next()
  ) {
    const edge = oc.TopoDS.Edge_1(e.Current());
    if (seen.some((prev) => prev.IsSame(edge))) continue;
    seen.push(edge);

    const ad = new oc.BRepAdaptor_Curve_2(edge);
    const isLine = ad.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line;
    const d = isLine ? ad.Line().Direction() : null;
    const m = ad.Value((ad.FirstParameter() + ad.LastParameter()) / 2);
    out.push({
      edge,
      dir: d ? [d.X(), d.Y(), d.Z()] : null,
      mid: [m.X(), m.Y(), m.Z()],
    });
  }

  const r = (n: number) => Math.round(n * 1e6);
  out.sort((a, b) =>
    r(a.mid[0]) - r(b.mid[0]) || r(a.mid[1]) - r(b.mid[1]) || r(a.mid[2]) - r(b.mid[2]));
  return out;
}

function pickEdges(edges: EdgeInfo[], sel: EdgeSelection): EdgeInfo[] {
  switch (sel.mode) {
    case 'all': return edges;
    case 'vertical': return edges.filter((e) => e.dir && Math.abs(e.dir[2]) > 0.99);
    case 'indices': return sel.indices.map((i) => edges[i]).filter(Boolean);
  }
}

export function fillet(
  oc: OpenCascadeInstance, shape: TopoDS_Shape, radius: number, sel: EdgeSelection,
): TopoDS_Shape {
  if (radius <= 0) return shape;
  const picked = pickEdges(orderedEdges(oc, shape), sel);
  if (picked.length === 0) return shape;
  const mk = new oc.BRepFilletAPI_MakeFillet(
    shape, enumVal<ChFi3d_FilletShape>(oc.ChFi3d_FilletShape.ChFi3d_Rational),
  );
  for (const e of picked) mk.Add_2(radius, e.edge);
  return mk.Shape();
}

export function chamfer(
  oc: OpenCascadeInstance, shape: TopoDS_Shape, distance: number, sel: EdgeSelection,
): TopoDS_Shape {
  if (distance <= 0) return shape;
  const picked = pickEdges(orderedEdges(oc, shape), sel);
  if (picked.length === 0) return shape;
  const mk = new oc.BRepFilletAPI_MakeChamfer(shape);
  for (const e of picked) mk.Add_2(distance, e.edge);
  return mk.Shape();
}

// --------------------------------------------------------------------------
// Medición y teselado
// --------------------------------------------------------------------------

export function volume(oc: OpenCascadeInstance, shape: TopoDS_Shape): number {
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
  return props.Mass();
}

export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
  /** Pares de vértices con las aristas del sólido, para dibujar el contorno. */
  edges: Float32Array;
}

/**
 * Tesela la forma y devuelve buffers listos para Three.js.
 *
 * No calcula normales: cada cara de OCCT aporta su propio juego de nodos, así
 * que `computeVertexNormals()` de Three.js da justo lo que queremos en CAD
 * (plano entre caras distintas, suave dentro de una cara curva).
 */
export function shapeToMesh(
  oc: OpenCascadeInstance, shape: TopoDS_Shape, deflection = 0.1,
): MeshData {
  new oc.BRepMesh_IncrementalMesh_2(shape, deflection, false, 0.5, false);

  const positions: number[] = [];
  const indices: number[] = [];

  for (
    const exp = new oc.TopExp_Explorer_2(
      shape,
      enumVal<TopAbs_ShapeEnum>(oc.TopAbs_ShapeEnum.TopAbs_FACE),
      enumVal<TopAbs_ShapeEnum>(oc.TopAbs_ShapeEnum.TopAbs_SHAPE),
    );
    exp.More(); exp.Next()
  ) {
    const face = oc.TopoDS.Face_1(exp.Current());
    const loc = new oc.TopLoc_Location_1();
    // 0 = Poly_MeshPurpose_NONE; el enum no está expuesto en runtime.
    const handle = oc.BRep_Tool.Triangulation(face, loc, enumVal(0));
    if (handle.IsNull()) continue;

    const tri = handle.get();
    const trsf = loc.Transformation();
    const base = positions.length / 3;
    // Una cara REVERSED trae su triangulación con el bobinado invertido.
    const reversed = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;

    for (let i = 1; i <= tri.NbNodes(); i++) {
      const p = tri.Node(i).Transformed(trsf);
      positions.push(p.X(), p.Y(), p.Z());
    }
    for (let i = 1; i <= tri.NbTriangles(); i++) {
      const t = tri.Triangle(i);
      const a = base + t.Value(1) - 1;
      const b = base + t.Value(2) - 1;
      const c = base + t.Value(3) - 1;
      if (reversed) indices.push(a, c, b);
      else indices.push(a, b, c);
    }
  }

  // Aristas discretizadas: sin esto el render parece una mancha, no una pieza.
  const edges: number[] = [];
  for (const { edge } of orderedEdges(oc, shape)) {
    const ad = new oc.BRepAdaptor_Curve_2(edge);
    const disc = new oc.GCPnts_QuasiUniformDeflection_2(ad, deflection, enumVal(0) /* GeomAbs_C0 */);
    if (!disc.IsDone()) continue;
    for (let i = 1; i < disc.NbPoints(); i++) {
      const p1 = disc.Value(i), p2 = disc.Value(i + 1);
      edges.push(p1.X(), p1.Y(), p1.Z(), p2.X(), p2.Y(), p2.Z());
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    edges: new Float32Array(edges),
  };
}

// --------------------------------------------------------------------------
// Exportación
// --------------------------------------------------------------------------

/**
 * Exporta a STEP o STL.
 *
 * OCCT escribe en el sistema de archivos virtual de Emscripten, así que hay que
 * leer el archivo de vuelta para poder descargarlo.
 */
export function exportShape(
  oc: OpenCascadeInstance, shape: TopoDS_Shape, format: 'step' | 'stl',
): Blob {
  const path = `/export.${format}`;
  if (format === 'step') {
    const w = new oc.STEPControl_Writer_1();
    w.Transfer(
      shape,
      enumVal(oc.STEPControl_StepModelType.STEPControl_AsIs),
      true,
      new oc.Message_ProgressRange_1(),
    );
    w.Write(path);
  } else {
    // El STL es una malla: hay que teselar antes o sale vacío.
    new oc.BRepMesh_IncrementalMesh_2(shape, 0.02, false, 0.3, false);
    const w = new oc.StlAPI_Writer();
    w.Write(shape, path, new oc.Message_ProgressRange_1());
  }
  const data = oc.FS.readFile(path) as Uint8Array;
  oc.FS.unlink(path);
  return new Blob([data as BlobPart], {
    type: format === 'step' ? 'application/step' : 'model/stl',
  });
}
