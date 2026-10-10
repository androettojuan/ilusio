import { useDocument } from '../store/useDocument';
import type { PlaneRef } from '../model/types';
import { PLANE_LABEL } from './icons';

/** Serializa una referencia de plano para poder usarla como value de un <select>. */
export const planeKey = (ref: PlaneRef): string =>
  ref.kind === 'base' ? `base:${ref.plane}`
    : ref.kind === 'plane' ? `plane:${ref.featureId}`
      : `face:${ref.faceIndex}`;

export function parsePlaneKey(key: string): PlaneRef {
  const [kind, value] = key.split(':');
  if (kind === 'plane') return { kind: 'plane', featureId: value };
  if (kind === 'face') return { kind: 'face', faceIndex: Number(value) };
  return { kind: 'base', plane: value as keyof typeof PLANE_LABEL };
}

export interface PlaneOption { key: string; label: string; ref: PlaneRef }

/**
 * Planos disponibles para apoyar un boceto: los tres del origen, los planos de
 * construcción y las caras planas del cuerpo.
 *
 * `excludeFeatureId` evita que un plano se ofrezca como base de sí mismo.
 */
export function usePlaneOptions(excludeFeatureId?: string): PlaneOption[] {
  const features = useDocument((s) => s.doc.features);
  const result = useDocument((s) => s.result);

  const options: PlaneOption[] = (Object.keys(PLANE_LABEL) as (keyof typeof PLANE_LABEL)[])
    .map((p) => ({
      key: `base:${p}`, label: PLANE_LABEL[p], ref: { kind: 'base', plane: p },
    }));

  for (const f of features) {
    if (f.type !== 'plane' || f.id === excludeFeatureId) continue;
    options.push({
      key: `plane:${f.id}`, label: f.name, ref: { kind: 'plane', featureId: f.id },
    });
  }

  (result?.faces ?? []).forEach((_, i) => {
    options.push({
      key: `face:${i}`, label: `Cara ${i + 1} del cuerpo`, ref: { kind: 'face', faceIndex: i },
    });
  });

  return options;
}

export default function PlanePicker({ value, onChange, excludeFeatureId, ...rest }: {
  value: PlaneRef;
  onChange: (ref: PlaneRef) => void;
  excludeFeatureId?: string;
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'>) {
  const options = usePlaneOptions(excludeFeatureId);
  const key = planeKey(value);
  const known = options.some((o) => o.key === key);

  return (
    <select
      value={key}
      onChange={(e) => onChange(parsePlaneKey(e.target.value))}
      {...rest}
    >
      {/* Si la referencia apunta a algo que ya no está, se muestra igual para
          que el usuario vea por qué el feature está en rojo. */}
      {!known && <option value={key}>{key} (no existe)</option>}
      {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
    </select>
  );
}
