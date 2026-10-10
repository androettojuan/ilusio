/**
 * Motor de reconstrucción.
 *
 * Recorre los features del documento en orden y aplica cada uno sobre el
 * resultado del anterior. Es la única forma de obtener geometría: nunca se
 * guarda una malla, siempre se recalcula desde los parámetros. Eso es lo que
 * hace que el historial sea editable.
 */
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js';
import type {
  DesignDocument, Feature, PlaneRef, ProfileSelection,
} from '../model/types';
import { getOCCT } from './occt';
import {
  orderedRegions, solveSketch, type IndexedRegion, type SolvedSketch,
} from './sketch';
import {
  PLANES, boolOp, chamfer, extrude, fillet, flipPlane, offsetPlane, planarFaces,
  regionToFace, revolve, shapeToMesh, volume,
  type MeshData, type PlaneBasis,
} from './shapes';

export interface Body {
  /** Feature que lo produjo. */
  featureId: string;
  name: string;
  shape: TopoDS_Shape;
  mesh: MeshData;
  volume: number;
}

export interface SketchResult {
  featureId: string;
  name: string;
  /** Plano ya resuelto: el boceto puede apoyarse en una cara o en un desfase. */
  basis: PlaneBasis;
  solved: SolvedSketch;
  /** Perfiles cerrados con su índice estable. Vacío = no se puede extruir. */
  regions: IndexedRegion[];
}

export interface PlaneResult {
  featureId: string;
  name: string;
  basis: PlaneBasis;
  /** Mitad del lado del cuadrado con que se dibuja, en mm. */
  extent: number;
}

export interface FeatureStatus {
  featureId: string;
  ok: boolean;
  error?: string;
  /** Milisegundos que tardó este feature. */
  ms: number;
}

export interface RebuildResult {
  bodies: Body[];
  sketches: SketchResult[];
  /** Planos de construcción, ya resueltos. */
  planes: PlaneResult[];
  /** Caras planas del resultado, para poder bocetar encima. */
  faces: PlaneBasis[];
  status: FeatureStatus[];
  totalMs: number;
}

/** Features que se van a ejecutar: hasta el marcador y sin los suprimidos. */
export function activeFeatures(doc: DesignDocument): Feature[] {
  return doc.features.slice(0, doc.rollbackIndex).filter((f) => !f.suppressed);
}

async function sketchRegions(
  doc: DesignDocument, sketchId: string, selection: ProfileSelection,
  cache: Map<string, SolvedSketch>,
  resolve: (ref: PlaneRef) => PlaneBasis,
) {
  const sketch = doc.features.find((f) => f.id === sketchId);
  if (!sketch || sketch.type !== 'sketch') {
    throw new Error('El boceto de referencia ya no existe');
  }
  let solved = cache.get(sketchId);
  if (!solved) {
    solved = await solveSketch(sketch, doc.parameters);
    cache.set(sketchId, solved);
  }

  const all = orderedRegions(solved.curves);
  if (all.length === 0) {
    throw new Error(`"${sketch.name}" no tiene ningún perfil cerrado`);
  }

  const regions = selection.mode === 'all'
    ? all
    : all.filter((r) => selection.indices.includes(r.index));
  return { sketch, regions, basis: resolve(sketch.plane) };
}

export async function rebuild(doc: DesignDocument): Promise<RebuildResult> {
  const t0 = performance.now();
  const oc: OpenCascadeInstance = await getOCCT();

  const solvedCache = new Map<string, SolvedSketch>();
  const sketches: SketchResult[] = [];
  const planes: PlaneResult[] = [];
  const status: FeatureStatus[] = [];

  const planeBasis = new Map<string, PlaneBasis>();
  /**
   * Caras del cuerpo de arriba de la pila, recalculadas sólo cuando ese cuerpo
   * cambia: enumerarlas no es gratis y casi ningún feature las necesita.
   */
  let faceCache: { shape: TopoDS_Shape; faces: PlaneBasis[] } | null = null;
  const currentFaces = (): PlaneBasis[] => {
    const top = solids[solids.length - 1];
    if (!top) return [];
    if (faceCache?.shape !== top.shape) {
      faceCache = { shape: top.shape, faces: planarFaces(oc, top.shape) };
    }
    return faceCache.faces;
  };

  const resolve = (ref: PlaneRef): PlaneBasis => {
    switch (ref.kind) {
      case 'base':
        return PLANES[ref.plane];
      case 'plane': {
        const basis = planeBasis.get(ref.featureId);
        if (!basis) throw new Error('El plano de referencia ya no existe');
        return basis;
      }
      case 'face': {
        const faces = currentFaces();
        if (faces.length === 0) throw new Error('Todavía no hay ningún cuerpo con caras');
        const basis = faces[ref.faceIndex];
        if (!basis) {
          throw new Error(`La cara ${ref.faceIndex + 1} ya no existe (hay ${faces.length})`);
        }
        return basis;
      }
    }
  };

  /**
   * Pila de sólidos. Los features que crean geometría apilan uno nuevo o se
   * combinan con el último; los de modificación (empalme, chaflán) operan
   * sobre el último.
   */
  const solids: { featureId: string; name: string; shape: TopoDS_Shape }[] = [];

  for (const f of activeFeatures(doc)) {
    const tf = performance.now();
    try {
      switch (f.type) {
        case 'plane': {
          const base = resolve(f.base);
          const basis = offsetPlane(f.flipped ? flipPlane(base) : base, f.offset);
          planeBasis.set(f.id, basis);
          if (f.visible) {
            planes.push({ featureId: f.id, name: f.name, basis, extent: 60 });
          }
          break;
        }

        case 'sketch': {
          const solved = await solveSketch(f, doc.parameters);
          solvedCache.set(f.id, solved);
          sketches.push({
            featureId: f.id, name: f.name, basis: resolve(f.plane), solved,
            regions: orderedRegions(solved.curves),
          });
          break;
        }

        case 'extrude':
        case 'revolve': {
          const { regions, basis } = await sketchRegions(
            doc, f.sketchId, f.profiles, solvedCache, resolve,
          );
          // Sin perfiles elegidos no hay nada que construir. No es un error:
          // es el estado normal mientras se está armando la extrusión.
          if (regions.length === 0) break;
          const parts = regions.map((r) => {
            const face = regionToFace(oc, basis, r);
            return f.type === 'extrude'
              ? extrude(oc, face, basis, f.distance, f.symmetric)
              : revolve(oc, face, basis,
                  { x: f.axisOrigin[0], y: f.axisOrigin[1] },
                  { x: f.axisDir[0], y: f.axisDir[1] }, f.angle);
          });
          // Varios perfiles disjuntos en el mismo boceto se unen en un cuerpo.
          const made = parts.reduce((acc, s) => boolOp(oc, acc, s, 'join'));

          const target = solids[solids.length - 1];
          if (f.operation === 'new' || !target) {
            solids.push({ featureId: f.id, name: f.name, shape: made });
          } else {
            target.shape = boolOp(oc, target.shape, made, f.operation);
          }
          break;
        }

        case 'fillet':
        case 'chamfer': {
          const target = solids[solids.length - 1];
          if (!target) throw new Error('No hay ningún cuerpo al que aplicarlo');
          target.shape = f.type === 'fillet'
            ? fillet(oc, target.shape, f.radius, f.edges)
            : chamfer(oc, target.shape, f.distance, f.edges);
          break;
        }
      }
      status.push({ featureId: f.id, ok: true, ms: performance.now() - tf });
    } catch (e) {
      // Un feature que falla no tumba la reconstrucción: se marca en rojo en el
      // historial y los siguientes siguen con la geometría que había.
      status.push({
        featureId: f.id, ok: false,
        error: e instanceof Error ? e.message : String(e),
        ms: performance.now() - tf,
      });
    }
  }

  const visible = new Set(doc.features.filter((f) => f.visible).map((f) => f.id));
  const bodies: Body[] = solids
    .filter((s) => visible.has(s.featureId))
    .map((s) => ({
      featureId: s.featureId,
      name: s.name,
      shape: s.shape,
      mesh: shapeToMesh(oc, s.shape, 0.05),
      volume: volume(oc, s.shape),
    }));

  return {
    bodies, sketches, planes, status,
    faces: currentFaces(),
    totalMs: performance.now() - t0,
  };
}
