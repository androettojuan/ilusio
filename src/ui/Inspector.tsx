import { useDocument } from '../store/useDocument';
import PlanePicker from './PlanePicker';
import type {
  BooleanOp, ChamferFeature, EdgeSelection, ExtrudeFeature, Feature,
  FilletFeature, PlaneFeature, ProfileSelection, RevolveFeature,
} from '../model/types';

function Num({ label, value, onChange, step = 1, min, autoFocus, onEnter }: {
  label: string; value: number; onChange: (v: number) => void;
  step?: number; min?: number; autoFocus?: boolean; onEnter?: () => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <input
        type="number" value={value} step={step} min={min}
        autoFocus={autoFocus}
        data-testid={`field-${label}`}
        onFocus={(e) => autoFocus && e.target.select()}
        onChange={(e) => { const v = Number(e.target.value); if (!Number.isNaN(v)) onChange(v); }}
        onKeyDown={(e) => { if (e.key === 'Enter') onEnter?.(); }}
      />
    </div>
  );
}

const OPERATIONS: { value: BooleanOp; label: string }[] = [
  { value: 'new', label: 'Cuerpo nuevo' },
  { value: 'join', label: 'Unir' },
  { value: 'cut', label: 'Cortar' },
  { value: 'intersect', label: 'Intersecar' },
];

function OperationField({ value, onChange }: { value: BooleanOp; onChange: (v: BooleanOp) => void }) {
  return (
    <div className="field">
      <label>Operación</label>
      <select value={value} onChange={(e) => onChange(e.target.value as BooleanOp)}>
        {OPERATIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function EdgesField({ value, onChange }: { value: EdgeSelection; onChange: (v: EdgeSelection) => void }) {
  return (
    <div className="field">
      <label>Aristas</label>
      <select
        value={value.mode}
        onChange={(e) => onChange(
          e.target.value === 'indices'
            ? { mode: 'indices', indices: value.mode === 'indices' ? value.indices : [] }
            : { mode: e.target.value as 'all' | 'vertical' },
        )}
      >
        <option value="vertical">Sólo verticales</option>
        <option value="all">Todas</option>
        <option value="indices">Por índice</option>
      </select>
      {value.mode === 'indices' && (
        <input
          type="text"
          style={{ marginTop: 4 }}
          placeholder="0, 3, 7"
          value={value.indices.join(', ')}
          onChange={(e) => onChange({
            mode: 'indices',
            indices: e.target.value.split(',').map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n)),
          })}
        />
      )}
    </div>
  );
}

/**
 * Qué perfiles del boceto usa este feature.
 *
 * Con esto un mismo boceto alimenta varias extrusiones de distinta altura: se
 * marca acá, o se hace clic directamente sobre el perfil en el visor.
 */
function ProfilesField({ sketchId, value, onChange }: {
  sketchId: string;
  value: ProfileSelection;
  onChange: (v: ProfileSelection) => void;
}) {
  const result = useDocument((s) => s.result);
  const regions = result?.sketches.find((s) => s.featureId === sketchId)?.regions ?? [];

  if (regions.length === 0) {
    return (
      <div className="field">
        <label>Perfiles</label>
        <div className="hint">El boceto todavía no tiene ningún perfil cerrado.</div>
      </div>
    );
  }

  const selected = (i: number) => value.mode === 'all' || value.indices.includes(i);
  const toggle = (i: number) => {
    const current = value.mode === 'all' ? regions.map((r) => r.index) : value.indices;
    const next = current.includes(i) ? current.filter((x) => x !== i) : [...current, i].sort((a, b) => a - b);
    onChange(next.length === regions.length ? { mode: 'all' } : { mode: 'indices', indices: next });
  };

  return (
    <div className="field">
      <label>
        Perfiles ({value.mode === 'all' ? regions.length : value.indices.length} de {regions.length})
      </label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 4 }}>
        {regions.map((r) => (
          <label
            key={r.index}
            data-testid={`profile-${r.index}`}
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}
          >
            <input
              type="checkbox" style={{ width: 'auto' }}
              checked={selected(r.index)}
              onChange={() => toggle(r.index)}
            />
            <span>Perfil {r.index + 1}</span>
            <span className="hint" style={{ marginLeft: 'auto' }}>
              {r.area.toFixed(1)} mm²{r.holes.length > 0 && ` · ${r.holes.length} agujero(s)`}
            </span>
          </label>
        ))}
      </div>
      <div className="row-2">
        <button style={{ flex: 1 }} onClick={() => onChange({ mode: 'all' })}>Todos</button>
        <button style={{ flex: 1 }} onClick={() => onChange({ mode: 'indices', indices: [] })}>Ninguno</button>
      </div>
      <div className="hint" style={{ marginTop: 4 }}>
        También podés hacer clic sobre el perfil en el visor.
      </div>
    </div>
  );
}

function SketchPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  // El selector tiene que devolver una referencia estable: filtrar acá dentro
  // crearía un array nuevo en cada render y zustand entraría en bucle.
  const features = useDocument((s) => s.doc.features);
  const sketches = features.filter((f) => f.type === 'sketch');
  return (
    <div className="field">
      <label>Perfil</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {sketches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </div>
  );
}

function FeatureForm({ f, patch, pending, accept }: {
  f: Feature;
  patch: (p: Partial<Feature>) => void;
  /** El feature se está armando: el campo principal arranca enfocado. */
  pending: boolean;
  accept: () => void;
}) {
  switch (f.type) {
    case 'plane': {
      const pl = f as PlaneFeature;
      return (
        <>
          <div className="field">
            <label>Se apoya en</label>
            <PlanePicker
              value={pl.base}
              excludeFeatureId={pl.id}
              onChange={(base) => patch({ base })}
            />
          </div>
          <Num label="Desfase" value={pl.offset} onChange={(offset) => patch({ offset })} step={1} />
          <label className="hint" style={{ display: 'flex', gap: 6, marginBottom: 9 }}>
            <input
              type="checkbox" style={{ width: 'auto' }} checked={pl.flipped}
              onChange={(e) => patch({ flipped: e.target.checked })}
            />
            Invertir la normal
          </label>
        </>
      );
    }

    case 'sketch': {
      const editSketch = useDocument.getState().editSketch;
      return (
        <>
          <div className="field">
            <label>Plano</label>
            <PlanePicker value={f.plane} onChange={(plane) => patch({ plane })} />
          </div>
          <button style={{ width: '100%' }} onClick={() => editSketch(f.id)}>
            Editar boceto
          </button>
          <div className="hint" style={{ marginTop: 8 }}>
            {f.primitives.length} primitiva(s)
          </div>
        </>
      );
    }

    case 'extrude': {
      const e = f as ExtrudeFeature;
      return (
        <>
          <SketchPicker value={e.sketchId} onChange={(sketchId) => patch({ sketchId })} />
          <ProfilesField
            sketchId={e.sketchId} value={e.profiles}
            onChange={(profiles) => patch({ profiles })}
          />
          <Num
            label="Distancia" value={e.distance}
            onChange={(distance) => patch({ distance })}
            autoFocus={pending} onEnter={accept}
          />
          <label className="hint" style={{ display: 'flex', gap: 6, marginBottom: 9 }}>
            <input
              type="checkbox" style={{ width: 'auto' }} checked={e.symmetric}
              onChange={(ev) => patch({ symmetric: ev.target.checked })}
            />
            Simétrica respecto del plano
          </label>
          <OperationField value={e.operation} onChange={(operation) => patch({ operation })} />
        </>
      );
    }

    case 'revolve': {
      const r = f as RevolveFeature;
      return (
        <>
          <SketchPicker value={r.sketchId} onChange={(sketchId) => patch({ sketchId })} />
          <ProfilesField
            sketchId={r.sketchId} value={r.profiles}
            onChange={(profiles) => patch({ profiles })}
          />
          <Num
            label="Ángulo" value={r.angle} onChange={(angle) => patch({ angle })} min={1}
            autoFocus={pending} onEnter={accept}
          />
          <div className="field">
            <label>Eje: origen (u, v)</label>
            <div className="row-2">
              {[0, 1].map((i) => (
                <input
                  key={i} type="number" value={r.axisOrigin[i]}
                  onChange={(ev) => {
                    const a = [...r.axisOrigin] as [number, number];
                    a[i] = Number(ev.target.value);
                    patch({ axisOrigin: a });
                  }}
                />
              ))}
            </div>
          </div>
          <div className="field">
            <label>Eje: dirección (u, v)</label>
            <div className="row-2">
              {[0, 1].map((i) => (
                <input
                  key={i} type="number" value={r.axisDir[i]}
                  onChange={(ev) => {
                    const a = [...r.axisDir] as [number, number];
                    a[i] = Number(ev.target.value);
                    patch({ axisDir: a });
                  }}
                />
              ))}
            </div>
          </div>
          <OperationField value={r.operation} onChange={(operation) => patch({ operation })} />
        </>
      );
    }

    case 'fillet': {
      const x = f as FilletFeature;
      return (
        <>
          <Num
            label="Radio" value={x.radius} onChange={(radius) => patch({ radius })}
            step={0.5} min={0} autoFocus={pending} onEnter={accept}
          />
          <EdgesField value={x.edges} onChange={(edges) => patch({ edges })} />
        </>
      );
    }

    case 'chamfer': {
      const x = f as ChamferFeature;
      return (
        <>
          <Num
            label="Distancia" value={x.distance} onChange={(distance) => patch({ distance })}
            step={0.5} min={0} autoFocus={pending} onEnter={accept}
          />
          <EdgesField value={x.edges} onChange={(edges) => patch({ edges })} />
        </>
      );
    }
  }
}

export default function Inspector() {
  const doc = useDocument((s) => s.doc);
  const selection = useDocument((s) => s.selection);
  const result = useDocument((s) => s.result);
  const {
    patchFeature, requestDelete, patchCanvas, removeCanvasById,
    acceptPending, cancelPending,
  } = useDocument();
  const pendingId = useDocument((s) => s.pendingFeatureId);

  if (selection.kind === 'canvas') {
    const c = doc.canvases.find((x) => x.id === selection.id);
    if (!c) return <div className="insp"><div className="hint">Lienzo eliminado.</div></div>;
    return (
      <div className="insp">
        <div className="panel-title">Lienzo</div>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>{c.name}</div>
        <Num label="Ancho" value={c.width} onChange={(width) => patchCanvas(c.id, { width })} />
        <div className="field">
          <label>Centro (u, v)</label>
          <div className="row-2">
            {[0, 1].map((i) => (
              <input
                key={i} type="number" value={c.center[i]}
                onChange={(e) => {
                  const center = [...c.center] as [number, number];
                  center[i] = Number(e.target.value);
                  patchCanvas(c.id, { center });
                }}
              />
            ))}
          </div>
        </div>
        <div className="field">
          <label>Opacidad: {c.opacity.toFixed(2)}</label>
          <input
            type="range" min={0.05} max={1} step={0.05} value={c.opacity}
            onChange={(e) => patchCanvas(c.id, { opacity: Number(e.target.value) })}
          />
        </div>
        <button style={{ width: '100%', marginTop: 6 }} onClick={() => removeCanvasById(c.id)}>
          Eliminar lienzo
        </button>
      </div>
    );
  }

  if (selection.kind !== 'feature') {
    return (
      <div className="insp">
        <div className="panel-title">Propiedades</div>
        <div className="hint">Elegí un feature en el navegador o en el historial.</div>
      </div>
    );
  }

  const f = doc.features.find((x) => x.id === selection.id);
  if (!f) return <div className="insp"><div className="hint">Feature eliminado.</div></div>;
  const st = result?.status.find((s) => s.featureId === f.id);
  const pending = pendingId === f.id;

  // Un feature que se está armando y todavía no tiene perfiles no construye
  // nada; conviene decirlo en vez de dejar el visor vacío sin explicación.
  const noProfiles = pending
    && (f.type === 'extrude' || f.type === 'revolve')
    && f.profiles.mode === 'indices'
    && f.profiles.indices.length === 0;

  return (
    <div className="insp">
      <div className="panel-title">{pending ? `Nuevo: ${f.name}` : 'Propiedades'}</div>

      {pending && (
        <div style={{
          background: 'var(--panel-2)', border: '1px solid var(--accent)',
          borderRadius: 6, padding: 8, marginBottom: 10,
        }}>
          <div className="hint" style={{ marginBottom: 7 }}>
            {noProfiles
              ? 'Elegí los perfiles en el visor o en la lista, escribí la medida y confirmá.'
              : 'Escribí la medida y confirmá. Podés seguir cambiando los perfiles.'}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              data-testid="accept-pending"
              className="active" style={{ flex: 1 }}
              disabled={noProfiles}
              onClick={acceptPending}
            >Aceptar</button>
            <button data-testid="cancel-pending" onClick={cancelPending}>Cancelar</button>
          </div>
        </div>
      )}
      <div className="field">
        <label>Nombre</label>
        <input
          type="text" value={f.name}
          onChange={(e) => patchFeature(f.id, { name: e.target.value })}
        />
      </div>

      {st && !st.ok && <div className="error-box">{st.error}</div>}

      <FeatureForm
        f={f}
        patch={(p) => patchFeature(f.id, p)}
        pending={pending}
        accept={acceptPending}
      />

      <label className="hint" style={{ display: 'flex', gap: 6, margin: '10px 0' }}>
        <input
          type="checkbox" style={{ width: 'auto' }} checked={f.suppressed}
          onChange={(e) => patchFeature(f.id, { suppressed: e.target.checked })}
        />
        Suprimir
      </label>

      <button style={{ width: '100%' }} onClick={() => requestDelete(f.id)}>
        Eliminar feature (Supr)
      </button>

      {st?.ok && <div className="hint" style={{ marginTop: 8 }}>Reconstruido en {st.ms.toFixed(0)} ms</div>}
    </div>
  );
}
