/**
 * Acciones sobre un feature, compartidas por el navegador y el historial.
 *
 * Se arman en un solo lugar para que el menú diga lo mismo en los dos lados.
 */
import { useDocument } from '../store/useDocument';
import type { Feature } from '../model/types';
import type { MenuItem } from './ContextMenu';

export function featureMenuItems(feature: Feature): MenuItem[] {
  const s = useDocument.getState();
  const index = s.doc.features.findIndex((f) => f.id === feature.id);

  return [
    {
      label: feature.type === 'sketch' ? 'Editar boceto' : 'Editar parámetros',
      onClick: () => {
        s.select({ kind: 'feature', id: feature.id });
        if (feature.type === 'sketch') s.editSketch(feature.id);
      },
    },
    {
      label: feature.visible ? 'Ocultar' : 'Mostrar',
      onClick: () => s.toggleVisible(feature.id),
    },
    {
      label: feature.suppressed ? 'Activar' : 'Suprimir',
      onClick: () => s.patchFeature(feature.id, { suppressed: !feature.suppressed }),
    },
    {
      label: 'Retroceder el historial hasta acá',
      divider: true,
      onClick: () => s.rollbackTo(index),
    },
    {
      label: 'Eliminar',
      divider: true,
      danger: true,
      onClick: () => s.requestDelete(feature.id),
    },
  ];
}
