import { useDocument } from '../store/useDocument';
import { FEATURE_GLYPH, PLANE_LABEL } from './icons';
import { useFeatureMenu } from './useFeatureMenu';
import type { Feature } from '../model/types';

/** Ojo dibujado en SVG: los emoji no están disponibles en todos los sistemas. */
function Eye({ on, onClick }: { on: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      className={`eye${on ? '' : ' off'}`}
      title={on ? 'Ocultar' : 'Mostrar'}
      onClick={onClick}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
        <path d="M1 8s2.6-4.2 7-4.2S15 8 15 8s-2.6 4.2-7 4.2S1 8 1 8Z" />
        <circle cx="8" cy="8" r="1.9" />
        {!on && <path d="M3 13 13 3" strokeWidth="1.6" />}
      </svg>
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <div className="panel-title">{title}</div>
      <div className="tree-group">{children}</div>
    </>
  );
}

export default function Navigator() {
  const doc = useDocument((s) => s.doc);
  const result = useDocument((s) => s.result);
  const selection = useDocument((s) => s.selection);
  const { select, toggleVisible, editSketch, patchCanvas, removeCanvasById } = useDocument();
  const menu = useFeatureMenu();

  const failed = new Set(
    (result?.status ?? []).filter((s) => !s.ok).map((s) => s.featureId),
  );

  const node = (f: Feature) => (
    <div
      key={f.id}
      className={[
        'tree-node',
        selection.kind === 'feature' && selection.id === f.id ? 'selected' : '',
        failed.has(f.id) ? 'error' : '',
      ].join(' ').trim()}
      data-testid={`nav-${f.id}`}
      title={`${f.name} · clic derecho para más`}
      onClick={() => select({ kind: 'feature', id: f.id })}
      onDoubleClick={() => {
        select({ kind: 'feature', id: f.id });
        if (f.type === 'sketch') editSketch(f.id);
      }}
      onContextMenu={menu.onContextMenu(f)}
    >
      <span className="glyph">{FEATURE_GLYPH[f.type]}</span>
      <span className="name" title={f.name}>{f.name}</span>
      <Eye on={f.visible} onClick={(e) => { e.stopPropagation(); toggleVisible(f.id); }} />
    </div>
  );

  const sketches = doc.features.filter((f) => f.type === 'sketch');
  const solids = doc.features.filter((f) => f.type !== 'sketch');

  return (
    <div className="nav">
      <div className="panel-title">Navegador</div>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{doc.name}</div>

      <Section title="Origen">
        {(Object.keys(PLANE_LABEL) as (keyof typeof PLANE_LABEL)[]).map((p) => (
          <div key={p} className="tree-node" style={{ color: 'var(--muted)' }}>
            <span className="glyph">▱</span>
            <span className="name">{PLANE_LABEL[p]}</span>
          </div>
        ))}
      </Section>

      {doc.canvases.length > 0 && (
        <Section title="Lienzos">
          {doc.canvases.map((c) => (
            <div
              key={c.id}
              className={`tree-node${selection.kind === 'canvas' && selection.id === c.id ? ' selected' : ''}`}
              data-testid={`nav-${c.id}`}
              title={`${c.name} · clic derecho para más`}
              onClick={() => select({ kind: 'canvas', id: c.id })}
              onContextMenu={menu.openMenu([
                {
                  label: 'Editar posición y escala',
                  onClick: () => select({ kind: 'canvas', id: c.id }),
                },
                {
                  label: c.visible ? 'Ocultar' : 'Mostrar',
                  onClick: () => patchCanvas(c.id, { visible: !c.visible }),
                },
                {
                  label: 'Eliminar',
                  divider: true,
                  danger: true,
                  onClick: () => removeCanvasById(c.id),
                },
              ])}
            >
              <span className="glyph">▤</span>
              <span className="name" title={c.name}>{c.name}</span>
              <Eye
                on={c.visible}
                onClick={(e) => { e.stopPropagation(); patchCanvas(c.id, { visible: !c.visible }); }}
              />
            </div>
          ))}
        </Section>
      )}

      <Section title="Bocetos">
        {sketches.length === 0
          ? <div className="hint">Ninguno todavía.</div>
          : sketches.map(node)}
      </Section>

      <Section title="Cuerpos y operaciones">
        {solids.length === 0
          ? <div className="hint">Ninguna todavía.</div>
          : solids.map(node)}
      </Section>

      {menu.element}
    </div>
  );
}
