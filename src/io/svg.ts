/**
 * Importación de SVG a boceto.
 *
 * En vez de escribir un parser de paths (arcos elípticos, béziers cúbicas y
 * relativas incluidas), usamos la geometría que ya implementa el navegador:
 * `getTotalLength` / `getPointAtLength` sobre el propio elemento. Muestreamos
 * denso y después simplificamos, así los tramos rectos vuelven a ser dos puntos.
 */
import type { DesignDocument, PlaneRef, SketchFeature } from '../model/types';
import { uid } from '../model/document';
import { simplify } from '../model/simplify';
import type { SketchItem } from '../model/types';

interface Pt { x: number; y: number }
const CLOSE_TOL = 1e-3;

/** Muestrea un elemento SVG con geometría propia como polilínea. */
function samplePath(el: SVGGeometryElement, step: number): Pt[] {
  const total = el.getTotalLength();
  if (total === 0) return [];
  const n = Math.max(2, Math.min(4000, Math.ceil(total / step)));
  return Array.from({ length: n + 1 }, (_, i) => {
    const p = el.getPointAtLength((i / n) * total);
    return { x: p.x, y: p.y };
  });
}

export interface SvgImportOptions {
  /** Milímetros por unidad de SVG. */
  scale?: number;
  /** Tolerancia de simplificación, en mm. */
  tolerance?: number;
}

/**
 * Convierte un SVG en un boceto. Los puntos quedan fijos: un contorno
 * importado es una referencia, no algo que el solver deba mover.
 */
export function importSvg(
  doc: DesignDocument, svgText: string, plane: PlaneRef, fileName: string,
  { scale = 1, tolerance = 0.05 }: SvgImportOptions = {},
): SketchFeature {
  const host = document.createElement('div');
  // Fuera de pantalla pero renderizado: getTotalLength necesita estar en el DOM.
  host.style.cssText = 'position:absolute;left:-10000px;top:0;width:0;height:0;overflow:hidden';
  host.innerHTML = svgText;
  document.body.appendChild(host);

  const primitives: SketchItem[] = [];
  let np = 0, nl = 0;

  try {
    const svg = host.querySelector('svg');
    if (!svg) throw new Error('El archivo no contiene un elemento <svg>');

    // Y crece hacia abajo en SVG y hacia arriba en CAD: hay que espejar.
    const elements = svg.querySelectorAll<SVGGeometryElement>(
      'path, polyline, polygon, line, rect, circle, ellipse',
    );

    for (const el of elements) {
      const raw = samplePath(el, Math.max(0.2, tolerance * 4));
      if (raw.length < 2) continue;

      const pts = simplify(raw, tolerance / scale).map((p) => ({
        x: p.x * scale, y: -p.y * scale,
      }));

      const closed =
        Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < CLOSE_TOL;
      const corners = closed ? pts.slice(0, -1) : pts;
      if (corners.length < 2) continue;

      const ids = corners.map(() => `p${np++}`);
      corners.forEach((p, i) => {
        primitives.push({ id: ids[i], type: 'point', x: p.x, y: p.y, fixed: true });
      });
      const segs = closed ? corners.length : corners.length - 1;
      for (let i = 0; i < segs; i++) {
        primitives.push({
          id: `l${nl++}`, type: 'line',
          p1_id: ids[i], p2_id: ids[(i + 1) % corners.length],
        });
      }
    }
  } finally {
    host.remove();
  }

  if (primitives.length === 0) {
    throw new Error('No se encontró geometría en el SVG');
  }

  const n = doc.features.filter((f) => f.name.startsWith('SVG')).length + 1;
  return {
    id: uid('sk'), type: 'sketch',
    name: `SVG ${n} · ${fileName.replace(/\.svg$/i, '')}`,
    suppressed: false, visible: true, plane, primitives,
  };
}
