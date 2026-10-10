/** Exportación a archivo y descarga desde el navegador. */
import { getOCCT } from '../kernel/occt';
import { boolOp, exportShape } from '../kernel/shapes';
import type { Body } from '../kernel/rebuild';

export async function downloadModel(
  bodies: Body[], format: 'step' | 'stl', baseName: string,
): Promise<void> {
  if (bodies.length === 0) throw new Error('No hay ningún cuerpo para exportar');
  const oc = await getOCCT();
  // Varios cuerpos van como un solo compuesto fusionado.
  const shape = bodies
    .map((b) => b.shape)
    .reduce((acc, s) => boolOp(oc, acc, s, 'join'));

  const blob = exportShape(oc, shape, format);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName.replace(/[^\w\-. ]+/g, '_')}.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}
