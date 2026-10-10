import { dependentsOf } from '../model/document';
import { useDocument } from '../store/useDocument';

/**
 * Confirmación de borrado.
 *
 * Si algo depende del feature hay tres salidas razonables y conviene darlas
 * explícitas: llevárselo todo, borrar sólo éste y dejar los otros en rojo (a
 * veces es lo que uno quiere, para reapuntarlos a otro boceto), o no borrar.
 */
export default function DeleteDialog() {
  const id = useDocument((s) => s.deleteRequest);
  const doc = useDocument((s) => s.doc);
  const { deleteFeature, cancelDelete } = useDocument();

  const feature = doc.features.find((f) => f.id === id);
  if (!feature) return null;

  const dependents = dependentsOf(doc, feature.id);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(10,13,16,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
      }}
      onClick={cancelDelete}
    >
      <div
        data-testid="delete-dialog"
        style={{
          background: 'var(--panel)', border: '1px solid var(--line)',
          borderRadius: 8, padding: 18, width: 'min(440px, 92vw)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Eliminar “{feature.name}”</div>

        {dependents.length === 0 ? (
          <div className="hint" style={{ marginBottom: 14 }}>
            No hay nada que dependa de este feature.
          </div>
        ) : (
          <div className="hint" style={{ marginBottom: 14 }}>
            Lo usa{dependents.length > 1 ? 'n' : ''}{' '}
            <b style={{ color: 'var(--text)' }}>
              {dependents.map((d) => d.name).join(', ')}
            </b>
            . Si lo borrás solo, esos features van a quedar en rojo hasta que les
            asignes otro perfil.
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button onClick={cancelDelete}>Cancelar</button>
          {dependents.length > 0 && (
            <button
              data-testid="delete-only"
              onClick={() => deleteFeature(feature.id, false)}
            >Borrar sólo éste</button>
          )}
          <button
            data-testid="delete-confirm"
            style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
            onClick={() => deleteFeature(feature.id, dependents.length > 0)}
          >
            {dependents.length > 0 ? `Borrar los ${dependents.length + 1}` : 'Eliminar'}
          </button>
        </div>
      </div>
    </div>
  );
}
