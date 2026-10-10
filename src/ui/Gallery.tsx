import { useEffect, useState } from 'react';
import {
  deleteDesign, estimateUsage, listDesigns, loadDesign, type DesignRecord,
} from '../db/designs';
import { useDocument } from '../store/useDocument';
import { emptyDocument, uid } from '../model/document';

type Meta = Omit<DesignRecord, 'doc'>;

/** Galería de diseños guardados: abrir, duplicar, renombrar y borrar. */
export default function Gallery({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Meta[] | null>(null);
  const [usage, setUsage] = useState<{ usedMB: number; quotaMB: number } | null>(null);
  const { load, saveNow, doc } = useDocument();

  const refresh = () => {
    void listDesigns().then(setItems);
    void estimateUsage().then(setUsage);
  };

  useEffect(refresh, []);

  const open = async (id: string) => {
    await saveNow(); // no perder lo que está abierto
    const rec = await loadDesign(id);
    if (rec) { load(rec.doc); onClose(); }
  };

  const duplicate = async (id: string) => {
    const rec = await loadDesign(id);
    if (!rec) return;
    load({
      ...rec.doc, id: uid('doc'), name: `${rec.doc.name} (copia)`,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    onClose();
  };

  const remove = async (id: string, name: string) => {
    if (!window.confirm(`¿Borrar "${name}"? No se puede deshacer.`)) return;
    await deleteDesign(id);
    refresh();
  };

  const createNew = async () => {
    await saveNow();
    load(emptyDocument('Sin título'));
    onClose();
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(10,13,16,0.75)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        data-testid="gallery"
        style={{
          background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8,
          width: 'min(880px, 92vw)', maxHeight: '84vh', display: 'flex',
          flexDirection: 'column', overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 16px', borderBottom: '1px solid var(--line)',
        }}>
          <b style={{ flex: 1 }}>Mis diseños</b>
          {usage && (
            <span className="hint">
              {usage.usedMB.toFixed(1)} MB usados de {(usage.quotaMB / 1000).toFixed(1)} GB
            </span>
          )}
          <button onClick={createNew}>Nuevo diseño</button>
          <button onClick={onClose}>Cerrar</button>
        </div>

        <div style={{
          padding: 16, overflowY: 'auto',
          display: 'grid', gap: 12,
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
        }}>
          {items === null && <div className="hint">Cargando…</div>}
          {items?.length === 0 && (
            <div className="hint">
              Todavía no hay diseños guardados. Se guardan solos mientras trabajás.
            </div>
          )}
          {items?.map((m) => (
            <div
              key={m.id}
              data-testid={`design-${m.id}`}
              style={{
                border: `1px solid ${m.id === doc.id ? 'var(--accent)' : 'var(--line)'}`,
                borderRadius: 6, overflow: 'hidden', background: 'var(--panel-2)',
              }}
            >
              <div
                style={{
                  height: 120, background: '#1a1e23', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
                onClick={() => open(m.id)}
                title="Abrir"
              >
                {m.thumbnail
                  ? <img src={m.thumbnail} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <span className="hint">sin vista previa</span>}
              </div>
              <div style={{ padding: '7px 9px' }}>
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.name}{m.id === doc.id && ' · abierto'}
                </div>
                <div className="hint" style={{ marginBottom: 6 }}>
                  {new Date(m.updatedAt).toLocaleString('es')}
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button style={{ flex: 1 }} onClick={() => open(m.id)}>Abrir</button>
                  <button onClick={() => duplicate(m.id)} title="Duplicar">Dup.</button>
                  <button onClick={() => remove(m.id, m.name)} title="Borrar">✕</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
