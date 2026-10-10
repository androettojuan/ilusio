/**
 * Estado de la aplicación.
 *
 * El documento se guarda como una pila de versiones inmutables, así que el
 * undo es simplemente retroceder un índice. Cualquier cambio pasa por `commit`.
 */
import { create } from 'zustand';
import type {
  Canvas, DesignDocument, Feature, PlaneId, PlaneRef, ProfileSelection,
} from '../model/types';
import {
  addFeature, dependentsOf, emptyDocument, makeCanvas, makeChamfer, makeExtrude,
  makeFillet, makePlane, makeRevolve, makeSketch, moveFeature, removeFeatures,
  setRollback, updateCanvas, updateFeature,
} from '../model/document';
import { rebuild, type RebuildResult } from '../kernel/rebuild';
import { saveDesign } from '../db/designs';

const MAX_HISTORY = 100;

/** Una extrusión recién creada no tiene perfiles: se eligen antes de aceptar. */
const noProfiles = (): ProfileSelection => ({ mode: 'indices', indices: [] });

export type Selection =
  | { kind: 'none' }
  | { kind: 'feature'; id: string }
  | { kind: 'canvas'; id: string };

interface State {
  past: DesignDocument[];
  doc: DesignDocument;
  future: DesignDocument[];

  result: RebuildResult | null;
  rebuilding: boolean;
  /** Boceto que se está editando, o null si estamos en el modelo 3D. */
  editingSketchId: string | null;
  /** Feature cuyo borrado está esperando confirmación. */
  deleteRequest: string | null;
  /** Plano sobre el que se crean los bocetos nuevos. */
  activePlane: PlaneRef;
  /**
   * Feature que se está armando y todavía no se confirmó. Mientras tanto el
   * inspector muestra Aceptar/Cancelar y el visor deja elegir los perfiles.
   */
  pendingFeatureId: string | null;
  selection: Selection;
  /** Se incrementa para pedirle al visor que encuadre la vista. */
  fitNonce: number;
  /** Lo instala el visor: devuelve una miniatura PNG de lo que se ve. */
  captureThumbnail: (() => string | null) | null;
  saveState: 'idle' | 'saving' | 'saved' | 'error';

  /**
   * Guarda un cambio. `coalesceKey` agrupa los cambios seguidos del mismo
   * gesto en un solo paso de historial: arrastrar un punto o tipear en un
   * campo dispara decenas de cambios, y deshacerlos de a uno es inusable.
   */
  commit: (next: DesignDocument, coalesceKey?: string) => void;
  /** Cierra el gesto en curso: el próximo cambio abre un paso nuevo. */
  endCoalesce: () => void;
  undo: () => void;
  redo: () => void;
  load: (doc: DesignDocument) => void;

  newSketch: (plane: PlaneRef) => void;
  /** Plano de construcción desfasado del plano que se le pase. */
  newPlane: (base: PlaneRef) => void;
  extrudeFrom: (sketchId: string) => void;
  revolveFrom: (sketchId: string) => void;
  addFillet: () => void;
  addChamfer: () => void;
  patchFeature: (id: string, patch: Partial<Feature>, coalesceKey?: string) => void;
  /** Borra un feature; con `cascade`, también los que dependían de él. */
  deleteFeature: (id: string, cascade?: boolean) => void;
  /** Pide confirmación antes de borrar (el diálogo lo muestra App). */
  requestDelete: (id: string) => void;
  cancelDelete: () => void;
  reorderFeature: (id: string, to: number) => void;
  rollbackTo: (index: number) => void;
  toggleVisible: (id: string) => void;

  addCanvas: (name: string, src: string, plane: PlaneId) => void;
  patchCanvas: (id: string, patch: Partial<Canvas>, coalesceKey?: string) => void;
  removeCanvasById: (id: string) => void;

  editSketch: (id: string | null) => void;
  select: (s: Selection) => void;
  requestFit: () => void;
  setActivePlane: (ref: PlaneRef) => void;
  /** Confirma el feature en curso. */
  acceptPending: () => void;
  /** Descarta el feature en curso. */
  cancelPending: () => void;
  setThumbnailSource: (fn: (() => string | null) | null) => void;
  saveNow: () => Promise<void>;
  rename: (name: string) => void;
  runRebuild: () => Promise<void>;
}

/**
 * Las reconstrucciones se encolan: si llegan varias mientras una está en curso
 * (arrastrar un slider), sólo se ejecuta la última.
 */
let pending = false;
let running = false;

/** Gesto al que pertenece el último cambio, para no inflar el historial. */
let lastCoalesceKey: string | undefined;

/** Autoguardado con rebote: no tiene sentido escribir en cada tecla. */
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const AUTOSAVE_MS = 1200;

export const useDocument = create<State>((set, get) => {
  const schedule = () => {
    void get().runRebuild();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void get().saveNow(); }, AUTOSAVE_MS);
  };

  const apply = (fn: (d: DesignDocument) => DesignDocument, coalesceKey?: string) => {
    get().commit(fn(get().doc), coalesceKey);
  };

  return {
    past: [], doc: emptyDocument(), future: [],
    result: null, rebuilding: false, editingSketchId: null, deleteRequest: null,
    selection: { kind: 'none' }, fitNonce: 0,
    activePlane: { kind: 'base', plane: 'XY' }, pendingFeatureId: null,
    captureThumbnail: null, saveState: 'idle',

    commit: (next, coalesceKey) => {
      set((s) => {
        // Mismo gesto que el cambio anterior: se reemplaza el estado actual y
        // el punto de deshacer sigue siendo el de antes de empezar el gesto.
        const sameGesture = coalesceKey !== undefined && coalesceKey === lastCoalesceKey;
        lastCoalesceKey = coalesceKey;
        return {
          past: sameGesture ? s.past : [...s.past, s.doc].slice(-MAX_HISTORY),
          doc: next,
          future: [],
        };
      });
      schedule();
    },

    endCoalesce: () => { lastCoalesceKey = undefined; },

    undo: () => {
      lastCoalesceKey = undefined;
      const { past, doc, future } = get();
      if (past.length === 0) return;
      set({ past: past.slice(0, -1), doc: past[past.length - 1], future: [doc, ...future] });
      schedule();
    },

    redo: () => {
      lastCoalesceKey = undefined;
      const { past, doc, future } = get();
      if (future.length === 0) return;
      set({ past: [...past, doc], doc: future[0], future: future.slice(1) });
      schedule();
    },

    load: (doc) => {
      set({
        past: [], doc, future: [], selection: { kind: 'none' },
        editingSketchId: null, pendingFeatureId: null,
      });
      schedule();
    },

    newPlane: (base) => {
      const f = makePlane(get().doc, base);
      get().commit(addFeature(get().doc, f));
      set({ selection: { kind: 'feature', id: f.id } });
    },

    newSketch: (plane) => {
      const sketch = makeSketch(get().doc, plane);
      get().commit(addFeature(get().doc, sketch));
      set({ editingSketchId: sketch.id, selection: { kind: 'feature', id: sketch.id } });
    },

    extrudeFrom: (sketchId) => {
      // Arranca sin perfiles: el usuario elige cuáles antes de confirmar.
      const f = { ...makeExtrude(get().doc, sketchId), profiles: noProfiles() };
      get().commit(addFeature(get().doc, f));
      set({ selection: { kind: 'feature', id: f.id }, pendingFeatureId: f.id });
    },

    revolveFrom: (sketchId) => {
      const f = { ...makeRevolve(get().doc, sketchId), profiles: noProfiles() };
      get().commit(addFeature(get().doc, f));
      set({ selection: { kind: 'feature', id: f.id }, pendingFeatureId: f.id });
    },

    acceptPending: () => set({ pendingFeatureId: null }),

    cancelPending: () => {
      const id = get().pendingFeatureId;
      if (id) get().deleteFeature(id);
      set({ pendingFeatureId: null });
    },

    addFillet: () => {
      const f = makeFillet(get().doc);
      get().commit(addFeature(get().doc, f));
      set({ selection: { kind: 'feature', id: f.id }, pendingFeatureId: f.id });
    },

    addChamfer: () => {
      const f = makeChamfer(get().doc);
      get().commit(addFeature(get().doc, f));
      set({ selection: { kind: 'feature', id: f.id }, pendingFeatureId: f.id });
    },

    patchFeature: (id, patch, coalesceKey) =>
      apply((d) => updateFeature(d, id, patch), coalesceKey),
    requestDelete: (id) => set({ deleteRequest: id }),
    cancelDelete: () => set({ deleteRequest: null }),

    deleteFeature: (id, cascade = false) => {
      const ids = cascade
        ? [id, ...dependentsOf(get().doc, id).map((f) => f.id)]
        : [id];
      apply((d) => removeFeatures(d, ids));
      set((s) => ({
        deleteRequest: null,
        pendingFeatureId: ids.includes(s.pendingFeatureId ?? '') ? null : s.pendingFeatureId,
        selection: s.selection.kind === 'feature' && ids.includes(s.selection.id)
          ? { kind: 'none' } : s.selection,
        editingSketchId: s.editingSketchId && ids.includes(s.editingSketchId)
          ? null : s.editingSketchId,
      }));
    },
    reorderFeature: (id, to) => apply((d) => moveFeature(d, id, to)),
    rollbackTo: (index) => apply((d) => setRollback(d, index)),

    toggleVisible: (id) => {
      const f = get().doc.features.find((x) => x.id === id);
      if (f) apply((d) => updateFeature(d, id, { visible: !f.visible }));
    },

    addCanvas: (name, src, plane) => {
      const c = makeCanvas(name, src, plane);
      apply((d) => ({ ...d, canvases: [...d.canvases, c] }));
      set({ selection: { kind: 'canvas', id: c.id } });
    },
    patchCanvas: (id, patch, coalesceKey) =>
      apply((d) => updateCanvas(d, id, patch), coalesceKey),
    removeCanvasById: (id) =>
      apply((d) => ({ ...d, canvases: d.canvases.filter((c) => c.id !== id) })),

    editSketch: (id) => set({ editingSketchId: id }),
    select: (selection) => set({ selection }),
    requestFit: () => set((s) => ({ fitNonce: s.fitNonce + 1 })),
    setActivePlane: (activePlane) => set({ activePlane }),
    setThumbnailSource: (captureThumbnail) => set({ captureThumbnail }),
    rename: (name) => apply((d) => ({ ...d, name }), 'rename'),

    saveNow: async () => {
      const { doc, captureThumbnail } = get();
      set({ saveState: 'saving' });
      try {
        await saveDesign({
          id: doc.id, name: doc.name,
          createdAt: doc.createdAt, updatedAt: Date.now(),
          thumbnail: captureThumbnail?.() ?? null,
          doc,
        });
        set({ saveState: 'saved' });
      } catch {
        set({ saveState: 'error' });
      }
    },

    runRebuild: async () => {
      if (running) { pending = true; return; }
      running = true;
      set({ rebuilding: true });
      try {
        do {
          pending = false;
          const result = await rebuild(get().doc);
          set({ result });
        } while (pending);
      } finally {
        running = false;
        set({ rebuilding: false });
      }
    },
  };
});
