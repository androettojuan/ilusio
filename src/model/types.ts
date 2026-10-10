/**
 * Modelo de documento paramétrico.
 *
 * Regla de oro: un documento es una LISTA DE FEATURES serializable, nunca una
 * malla. Reconstruir el modelo es recorrer esa lista de principio a fin. De ahí
 * salen el historial editable, el undo, los parámetros y la persistencia.
 * Todo lo que se agregue tiene que poder expresarse como un feature más.
 */

import type { SketchPrimitive } from '@salusoft89/planegcs';

/**
 * Curva por puntos: la spline que se arma haciendo clic punto por punto.
 *
 * No se le pasa a PlaneGCS. Sus puntos sí son puntos normales del boceto, así
 * que se arrastran y se restringen como cualquier otro; la curva se recalcula a
 * partir de ellos. PlaneGCS sólo sabe trabajar con B-splines por polos, y una
 * curva que NO pasa por los puntos que marcaste no es lo que uno espera al
 * dibujar punto por punto.
 */
export interface SketchSpline {
  id: string;
  type: 'spline';
  point_ids: string[];
  /** Cerrada sobre sí misma. */
  periodic: boolean;
}

/** Todo lo que puede haber dentro de un boceto. */
export type SketchItem = SketchPrimitive | SketchSpline;

export const isSpline = (p: SketchItem): p is SketchSpline =>
  (p as SketchSpline).type === 'spline';

export type Vec3 = [number, number, number];

/** Los tres planos del origen. */
export type PlaneId = 'XY' | 'XZ' | 'YZ';

/**
 * Sobre qué se apoya un boceto o un plano de construcción.
 *
 * `face` usa el mismo índice determinista por centroide que la selección de
 * aristas: aguanta mientras la topología no cambie (ver EdgeSelection).
 */
export type PlaneRef =
  | { kind: 'base'; plane: PlaneId }
  | { kind: 'plane'; featureId: string }
  | { kind: 'face'; faceIndex: number };

export const basePlane = (plane: PlaneId): PlaneRef => ({ kind: 'base', plane });

// --------------------------------------------------------------------------
// Features
// --------------------------------------------------------------------------

export interface FeatureBase {
  id: string;
  name: string;
  /** Suprimido: sigue en el historial pero no se ejecuta. */
  suppressed: boolean;
  /** Visibilidad del resultado en el visor (ojito del navegador). */
  visible: boolean;
}

export interface SketchFeature extends FeatureBase {
  type: 'sketch';
  plane: PlaneRef;
  /**
   * Geometría y restricciones, casi todo en el formato que consume PlaneGCS.
   * Guardarlo tal cual evita una capa de traducción y hace el boceto
   * directamente serializable. La única excepción es `spline`, que resolvemos
   * nosotros (ver SketchSpline).
   */
  primitives: SketchItem[];
  /**
   * Dónde se corrió la etiqueta de cada cota respecto de su lugar por defecto.
   * Va acá y no dentro de la restricción: eso se le pasa tal cual a PlaneGCS y
   * no conviene ensuciarlo con datos de dibujo.
   */
  labelOffsets?: Record<string, [number, number]>;
}

/** Qué hacer con el sólido resultante respecto de lo que ya existe. */
export type BooleanOp = 'new' | 'join' | 'cut' | 'intersect';

/**
 * Qué perfiles cerrados del boceto usa un feature.
 *
 * Con esto, un mismo boceto puede dar varias extrusiones de distinta altura:
 * cada una toma los perfiles que le tocan. Los índices salen de
 * `orderedRegions`, que los ordena por centroide para que sobrevivan a que se
 * agregue geometría en otra parte del boceto.
 */
export type ProfileSelection =
  | { mode: 'all' }
  | { mode: 'indices'; indices: number[] };

export interface ExtrudeFeature extends FeatureBase {
  type: 'extrude';
  sketchId: string;
  profiles: ProfileSelection;
  distance: number;
  /** Extruir hacia los dos lados del plano, repartiendo la distancia. */
  symmetric: boolean;
  operation: BooleanOp;
}

export interface RevolveFeature extends FeatureBase {
  type: 'revolve';
  sketchId: string;
  profiles: ProfileSelection;
  /** Eje en coordenadas del plano del boceto. */
  axisOrigin: [number, number];
  axisDir: [number, number];
  /** Ángulo en grados. */
  angle: number;
  operation: BooleanOp;
}

/**
 * Selección de aristas.
 *
 * El "topological naming problem": si el usuario elige la arista n.º 7 y luego
 * cambia un feature anterior, la n.º 7 puede ser otra. Mitigación de v1: las
 * aristas se ordenan de forma determinista por su punto medio, así que mientras
 * la topología no cambie la selección se mantiene. `all` y `vertical` son
 * selecciones por regla, inmunes al problema.
 */
export type EdgeSelection =
  | { mode: 'all' }
  | { mode: 'vertical' }
  | { mode: 'indices'; indices: number[] };

export interface FilletFeature extends FeatureBase {
  type: 'fillet';
  radius: number;
  edges: EdgeSelection;
}

export interface ChamferFeature extends FeatureBase {
  type: 'chamfer';
  distance: number;
  edges: EdgeSelection;
}

/**
 * Plano de construcción: uno nuevo, desfasado de un plano base, de otro plano
 * de construcción o de una cara del sólido.
 *
 * Es un feature del historial, como en Fusion: así se recalcula solo cuando
 * cambia aquello de lo que cuelga.
 */
export interface PlaneFeature extends FeatureBase {
  type: 'plane';
  base: PlaneRef;
  /** Desplazamiento a lo largo de la normal, en mm. */
  offset: number;
  /** Invierte la normal (cambia qué lado es "arriba"). */
  flipped: boolean;
}

export type Feature =
  | PlaneFeature
  | SketchFeature
  | ExtrudeFeature
  | RevolveFeature
  | FilletFeature
  | ChamferFeature;

export type FeatureType = Feature['type'];

// --------------------------------------------------------------------------
// Lienzos (imágenes de referencia)
// --------------------------------------------------------------------------

export interface Canvas {
  id: string;
  name: string;
  visible: boolean;
  plane: PlaneId;
  /** Data URL de la imagen. Al persistir se guarda como blob aparte. */
  src: string;
  /** Posición del centro del lienzo sobre el plano, en mm. */
  center: [number, number];
  /** Ancho en mm; el alto sale de la relación de aspecto de la imagen. */
  width: number;
  rotation: number;
  opacity: number;
}

// --------------------------------------------------------------------------
// Documento
// --------------------------------------------------------------------------

export interface DesignDocument {
  id: string;
  name: string;
  units: 'mm';
  /** Parámetros con nombre, usables en las cotas del boceto. */
  parameters: Record<string, number>;
  features: Feature[];
  canvases: Canvas[];
  /**
   * Marcador del historial: sólo se ejecutan los features con índice menor.
   * `features.length` significa "al final", que es lo normal.
   */
  rollbackIndex: number;
  createdAt: number;
  updatedAt: number;
}
