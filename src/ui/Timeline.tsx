import { useState } from 'react';
import { useDocument } from '../store/useDocument';
import { FEATURE_GLYPH } from './icons';
import { useFeatureMenu } from './useFeatureMenu';

/**
 * Historial de la barra inferior.
 *
 * El marcador azul es el `rollbackIndex`: todo lo que queda a su derecha
 * existe en el documento pero no se ejecuta. Los chips se pueden arrastrar
 * para reordenar la construcción.
 */
export default function Timeline() {
  const doc = useDocument((s) => s.doc);
  const result = useDocument((s) => s.result);
  const rebuilding = useDocument((s) => s.rebuilding);
  const selection = useDocument((s) => s.selection);
  const { select, rollbackTo, reorderFeature, editSketch } = useDocument();

  const [dragId, setDragId] = useState<string | null>(null);
  const menu = useFeatureMenu();

  const status = new Map((result?.status ?? []).map((s) => [s.featureId, s]));
  const marker = doc.rollbackIndex;

  const gap = (index: number) => (
    <div
      key={`gap-${index}`}
      className="tl-gap"
      title="Mover el marcador del historial acá"
      data-testid={`tl-gap-${index}`}
      onClick={() => rollbackTo(index)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => {
        if (dragId) reorderFeature(dragId, Math.max(0, index - 1));
        setDragId(null);
      }}
    />
  );

  return (
    <div className="timeline" data-testid="timeline">
      <button
        onClick={() => rollbackTo(0)}
        disabled={marker === 0}
        title="Ir al principio"
      >⏮</button>
      <button
        onClick={() => rollbackTo(marker - 1)}
        disabled={marker === 0}
        title="Un paso atrás"
      >◀</button>
      <button
        onClick={() => rollbackTo(marker + 1)}
        disabled={marker >= doc.features.length}
        title="Un paso adelante"
      >▶</button>
      <button
        onClick={() => rollbackTo(doc.features.length)}
        disabled={marker >= doc.features.length}
        title="Ir al final"
      >⏭</button>

      <div className="tl-features">
        {doc.features.length === 0 && (
          <span className="hint" style={{ paddingLeft: 8 }}>
            El historial se va llenando a medida que creás features.
          </span>
        )}
        {doc.features.map((f, i) => {
          const st = status.get(f.id);
          return (
            <span key={f.id} style={{ display: 'flex', alignItems: 'center' }}>
              {i === marker ? <div className="tl-marker" data-testid="tl-marker" /> : gap(i)}
              <div
                className={[
                  'tl-chip',
                  selection.kind === 'feature' && selection.id === f.id ? 'selected' : '',
                  f.suppressed ? 'suppressed' : '',
                  i >= marker ? 'suppressed' : '',
                  st && !st.ok ? 'failed' : '',
                ].join(' ').trim()}
                draggable
                data-testid={`tl-chip-${f.id}`}
                onDragStart={() => setDragId(f.id)}
                onDragEnd={() => setDragId(null)}
                onClick={() => select({ kind: 'feature', id: f.id })}
                onDoubleClick={() => {
                  select({ kind: 'feature', id: f.id });
                  if (f.type === 'sketch') editSketch(f.id);
                }}
                onContextMenu={menu.onContextMenu(f)}
                title={st?.error ?? `${f.name} · ${st ? `${st.ms.toFixed(0)} ms` : 'sin ejecutar'} · clic derecho para más`}
              >
                <span className="glyph">{FEATURE_GLYPH[f.type]}</span>
                {f.name}
              </div>
            </span>
          );
        })}
        {marker >= doc.features.length && doc.features.length > 0 && (
          <div className="tl-marker" data-testid="tl-marker" />
        )}
      </div>

      <div style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 11, whiteSpace: 'nowrap' }}>
        {rebuilding
          ? 'reconstruyendo…'
          : result && `${result.totalMs.toFixed(0)} ms · ${result.bodies.length} cuerpo(s)`}
      </div>
      {menu.element}
    </div>
  );
}
