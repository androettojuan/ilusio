// Validación del kernel 3D: extruir, empalmar, revolucionar, teselar, exportar.
import { loadOCCT } from './oc-node.mjs';
import { writeFileSync } from 'fs';

const oc = await loadOCCT();
console.log('[1] OCCT cargado');

const P = (x, y, z) => new oc.gp_Pnt_3(x, y, z);
const volume = (shape) => {
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
  return props.Mass();
};

// --- Perfil que vendría del solver: rectángulo 80 x 50 en el plano XY ---
const corners = [[0, 0], [80, 0], [80, 50], [0, 50]];
const mw = new oc.BRepBuilderAPI_MakeWire_1();
for (let i = 0; i < 4; i++) {
  const a = corners[i], b = corners[(i + 1) % 4];
  mw.Add_1(new oc.BRepBuilderAPI_MakeEdge_3(P(a[0], a[1], 0), P(b[0], b[1], 0)).Edge());
}
const face = new oc.BRepBuilderAPI_MakeFace_15(mw.Wire(), false).Face();
console.log('[2] Perfil -> cara OK');

// --- EXTRUIR 20 mm ---
const prism = new oc.BRepPrimAPI_MakePrism_1(face, new oc.gp_Vec_4(0, 0, 20), false, true).Shape();
console.log('[3] Extrusión: volumen =', volume(prism).toFixed(2), '| esperado 80000');

// --- EMPALME 5 mm en las 4 aristas verticales ---
const fil = new oc.BRepFilletAPI_MakeFillet(prism, oc.ChFi3d_FilletShape.ChFi3d_Rational);
let n = 0;
// TopExp_Explorer devuelve cada arista una vez por cara adyacente, así que la misma
// arista aparece dos veces. TopTools_IndexedMapOfShape no está expuesto en este build,
// de modo que deduplicamos con IsSame.
const edges = [];
for (const e = new oc.TopExp_Explorer_2(prism, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); e.More(); e.Next()) {
  const cur = oc.TopoDS.Edge_1(e.Current());
  if (!edges.some(prev => prev.IsSame(cur))) edges.push(cur);
}
console.log('    aristas únicas:', edges.length, '| una caja tiene 12');
for (const edge of edges) {
  const ad = new oc.BRepAdaptor_Curve_2(edge);
  if (ad.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) continue;
  if (Math.abs(ad.Line().Direction().Z()) > 0.99) { fil.Add_2(5, edge); n++; }
}
const rounded = fil.Shape();
console.log(`[4] Empalme en ${n} aristas: volumen =`, volume(rounded).toFixed(2), '| esperado ~79570.8');

// --- REVOLUCIÓN 360° sobre un eje paralelo a Y, desplazado en X ---
const axis = new oc.gp_Ax1_2(P(-10, 0, 0), new oc.gp_Dir_4(0, 1, 0));
const revol = new oc.BRepPrimAPI_MakeRevol_1(face, axis, 2 * Math.PI, true).Shape();
// Pappus: V = 2*pi*R_centroide*A = 2*pi*50*4000
console.log('[5] Revolución 360:', volume(revol).toFixed(2), '| esperado ~1256637.1');
const revol90 = new oc.BRepPrimAPI_MakeRevol_1(face, axis, Math.PI / 2, true).Shape();
console.log('[5b] Revolución 90:', volume(revol90).toFixed(2), '| esperado ~314159.3');

// --- TESELADO para Three.js ---
new oc.BRepMesh_IncrementalMesh_2(rounded, 0.1, false, 0.5, false);
let tri = 0, verts = 0;
for (const e = new oc.TopExp_Explorer_2(rounded, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); e.More(); e.Next()) {
  const f = oc.TopoDS.Face_1(e.Current());
  const loc = new oc.TopLoc_Location_1();
  const h = oc.BRep_Tool.Triangulation(f, loc, 0 /* Poly_MeshPurpose_NONE: el enum no está expuesto en runtime */);
  if (h.IsNull()) continue;
  tri += h.get().NbTriangles();
  verts += h.get().NbNodes();
}
console.log(`[6] Malla: ${tri} triángulos, ${verts} vértices`);

// --- CARAS PLANAS, para poder bocetar encima ---
const faces = [];
const seenFaces = [];
for (
  const e = new oc.TopExp_Explorer_2(prism, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  e.More(); e.Next()
) {
  const f = oc.TopoDS.Face_1(e.Current());
  if (seenFaces.some((prev) => prev.IsSame(f))) continue;
  seenFaces.push(f);
  const ad = new oc.BRepAdaptor_Surface_2(f, true);
  if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) continue;
  const dir = ad.Plane().Position().Direction();
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.SurfaceProperties_1(f, props, false, false);
  const c = props.CentreOfMass();
  const sign = f.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED ? -1 : 1;
  faces.push({
    n: [dir.X() * sign, dir.Y() * sign, dir.Z() * sign].map((v) => Math.round(v)),
    o: [c.X(), c.Y(), c.Z()],
  });
}
const arriba = faces.find((f) => f.n[2] === 1);
console.log(`[8] Caras planas de la caja: ${faces.length} (esperado 6)`);
console.log(`    cara superior: normal (${arriba?.n}) centro z=${arriba?.o[2].toFixed(1)} | esperado z=20`);

// --- EXPORTAR STEP ---
const w = new oc.STEPControl_Writer_1();
w.Transfer(rounded, oc.STEPControl_StepModelType.STEPControl_AsIs, true, new oc.Message_ProgressRange_1());
// OCCT escribe en el sistema de archivos virtual de Emscripten (MEMFS);
// hay que leerlo de ahí para sacarlo al disco real o descargarlo en el navegador.
const status = w.Write('salida.step');
console.log('    Write() =', status, '| raiz del FS virtual:', oc.FS.readdir('/').join(' '));
const step = oc.FS.readFile('/salida.step', { encoding: 'utf8' });
writeFileSync('/tmp/pieza.step', step);
console.log(`[9] STEP exportado: ${step.length} bytes`);
