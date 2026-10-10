/** Iconos de los features en el historial y el navegador. */
import type { Feature } from '../model/types';
import { ICONS, type IconName } from './ToolIcons';

const FEATURE_ICON: Record<Feature['type'], IconName> = {
  plane: 'plane',
  sketch: 'sketch',
  extrude: 'extrude',
  revolve: 'revolve',
  fillet: 'fillet',
  chamfer: 'chamfer',
};

export const FeatureIcon = ({ type }: { type: Feature['type'] }) => ICONS[FEATURE_ICON[type]];

export const PLANE_LABEL = { XY: 'XY (planta)', XZ: 'XZ (frente)', YZ: 'YZ (lateral)' } as const;
