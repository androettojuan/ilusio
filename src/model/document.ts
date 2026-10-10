/** Creación y edición de documentos. Todo inmutable, para que el undo sea trivial. */
import {
  basePlane,
  type Canvas, type ChamferFeature, type DesignDocument, type ExtrudeFeature,
  type Feature, type FilletFeature, type PlaneFeature, type PlaneId,
  type PlaneRef, type RevolveFeature, type SketchFeature,
} from './types';

export const uid = (prefix: string) =>
  `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

export function emptyDocument(name = 'Sin título'): DesignDocument {
  const now = Date.now();
  return {
    id: uid('doc'), name, units: 'mm',
    parameters: {}, features: [], canvases: [],
    rollbackIndex: 0, createdAt: now, updatedAt: now,
  };
}

/** Nombre correlativo por tipo, como "Extrusión 2". */
function nextName(doc: DesignDocument, label: string): string {
  const n = doc.features.filter((f) => f.name.startsWith(label)).length + 1;
  return `${label} ${n}`;
}

const LABELS: Record<Feature['type'], string> = {
  plane: 'Plano', sketch: 'Boceto', extrude: 'Extrusión', revolve: 'Revolución',
  fillet: 'Empalme', chamfer: 'Chaflán',
};

/** Plano de construcción desfasado del que se le indique. */
export function makePlane(
  doc: DesignDocument, base: PlaneRef = basePlane('XY'), offset = 10,
): PlaneFeature {
  return {
    id: uid('pl'), type: 'plane', name: nextName(doc, LABELS.plane),
    suppressed: false, visible: true, base, offset, flipped: false,
  };
}

export function makeSketch(
  doc: DesignDocument, plane: PlaneRef = basePlane('XY'),
): SketchFeature {
  return {
    id: uid('sk'), type: 'sketch', name: nextName(doc, LABELS.sketch),
    suppressed: false, visible: true, plane, primitives: [],
  };
}

export function makeExtrude(doc: DesignDocument, sketchId: string): ExtrudeFeature {
  return {
    id: uid('ex'), type: 'extrude', name: nextName(doc, LABELS.extrude),
    suppressed: false, visible: true,
    sketchId, profiles: { mode: 'all' }, distance: 10, symmetric: false,
    operation: doc.features.some((f) => f.type === 'extrude' || f.type === 'revolve')
      ? 'join' : 'new',
  };
}

export function makeRevolve(doc: DesignDocument, sketchId: string): RevolveFeature {
  return {
    id: uid('rv'), type: 'revolve', name: nextName(doc, LABELS.revolve),
    suppressed: false, visible: true,
    sketchId, profiles: { mode: 'all' }, axisOrigin: [0, 0], axisDir: [0, 1], angle: 360,
    operation: doc.features.some((f) => f.type === 'extrude' || f.type === 'revolve')
      ? 'join' : 'new',
  };
}

export function makeFillet(doc: DesignDocument): FilletFeature {
  return {
    id: uid('fl'), type: 'fillet', name: nextName(doc, LABELS.fillet),
    suppressed: false, visible: true, radius: 2, edges: { mode: 'vertical' },
  };
}

export function makeChamfer(doc: DesignDocument): ChamferFeature {
  return {
    id: uid('ch'), type: 'chamfer', name: nextName(doc, LABELS.chamfer),
    suppressed: false, visible: true, distance: 1, edges: { mode: 'vertical' },
  };
}

export function makeCanvas(name: string, src: string, plane: PlaneId = 'XY'): Canvas {
  return {
    id: uid('cv'), name, visible: true, plane, src,
    center: [0, 0], width: 100, rotation: 0, opacity: 0.7,
  };
}

// --------------------------------------------------------------------------
// Operaciones sobre el documento
// --------------------------------------------------------------------------

const touch = (doc: DesignDocument): DesignDocument => ({ ...doc, updatedAt: Date.now() });

/** Inserta un feature en la posición del marcador del historial. */
export function addFeature(doc: DesignDocument, feature: Feature): DesignDocument {
  const features = [...doc.features];
  features.splice(doc.rollbackIndex, 0, feature);
  return touch({ ...doc, features, rollbackIndex: doc.rollbackIndex + 1 });
}

export function updateFeature(
  doc: DesignDocument, id: string, patch: Partial<Feature>,
): DesignDocument {
  return touch({
    ...doc,
    features: doc.features.map((f) => (f.id === id ? { ...f, ...patch } as Feature : f)),
  });
}

/**
 * Features que dejarían de funcionar si se borra `id`.
 *
 * Hoy la única dependencia explícita es el boceto que usan la extrusión y la
 * revolución. El empalme y el chaflán se aplican al último cuerpo, así que no
 * apuntan a nada por id.
 */
export function dependentsOf(doc: DesignDocument, id: string): Feature[] {
  return doc.features.filter(
    (f) => (f.type === 'extrude' || f.type === 'revolve') && f.sketchId === id,
  );
}

export function removeFeature(doc: DesignDocument, id: string): DesignDocument {
  const index = doc.features.findIndex((f) => f.id === id);
  if (index < 0) return doc;
  return touch({
    ...doc,
    features: doc.features.filter((f) => f.id !== id),
    rollbackIndex: doc.rollbackIndex > index ? doc.rollbackIndex - 1 : doc.rollbackIndex,
  });
}

/** Borra varios features de una, recalculando el marcador una sola vez. */
export function removeFeatures(doc: DesignDocument, ids: string[]): DesignDocument {
  const dead = new Set(ids);
  const removedBefore = doc.features
    .slice(0, doc.rollbackIndex)
    .filter((f) => dead.has(f.id)).length;
  return touch({
    ...doc,
    features: doc.features.filter((f) => !dead.has(f.id)),
    rollbackIndex: doc.rollbackIndex - removedBefore,
  });
}

/** Mueve un feature dentro del historial (arrastrar en la barra inferior). */
export function moveFeature(doc: DesignDocument, id: string, to: number): DesignDocument {
  const from = doc.features.findIndex((f) => f.id === id);
  if (from < 0 || to < 0 || to >= doc.features.length) return doc;
  const features = [...doc.features];
  const [f] = features.splice(from, 1);
  features.splice(to, 0, f);
  return touch({ ...doc, features });
}

export function setRollback(doc: DesignDocument, index: number): DesignDocument {
  return { ...doc, rollbackIndex: Math.max(0, Math.min(index, doc.features.length)) };
}

export function updateCanvas(
  doc: DesignDocument, id: string, patch: Partial<Canvas>,
): DesignDocument {
  return touch({
    ...doc,
    canvases: doc.canvases.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  });
}
