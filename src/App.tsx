import { useEffect } from 'react';
import './ui/styles.css';
import Ribbon from './ui/Ribbon';
import Navigator from './ui/Navigator';
import Inspector from './ui/Inspector';
import Timeline from './ui/Timeline';
import Viewport from './ui/Viewport';
import SketchEditor from './ui/SketchEditor';
import DeleteDialog from './ui/DeleteDialog';
import { planeKey, usePlaneOptions } from './ui/PlanePicker';
import { useDocument } from './store/useDocument';

export default function App() {
  const editingId = useDocument((s) => s.editingSketchId);
  const doc = useDocument((s) => s.doc);
  const result = useDocument((s) => s.result);
  const rebuilding = useDocument((s) => s.rebuilding);
  const { runRebuild, undo, redo, requestFit, saveNow, requestDelete } = useDocument();
  const selection = useDocument((s) => s.selection);

  // Primera reconstrucción: arranca la carga del wasm de OCCT en segundo plano.
  useEffect(() => { void runRebuild(); }, [runRebuild]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
      if (!(e.ctrlKey || e.metaKey)) {
        if (typing || editingId) return;
        if (e.key.toLowerCase() === 'f') requestFit();
        // Supr sobre el feature elegido: el diálogo avisa si algo depende de él.
        else if ((e.key === 'Delete' || e.key === 'Backspace')
                 && selection.kind === 'feature') {
          e.preventDefault();
          requestDelete(selection.id);
        }
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
      else if (k === 's') { e.preventDefault(); void saveNow(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, requestFit, saveNow, editingId, requestDelete, selection]);

  const editing = editingId
    ? doc.features.find((f) => f.id === editingId && f.type === 'sketch')
    : undefined;

  const totalVolume = (result?.bodies ?? []).reduce((a, b) => a + b.volume, 0);
  const activePlane = useDocument((s) => s.activePlane);
  const planeOptions = usePlaneOptions();
  const activeLabel = planeOptions.find((o) => o.key === planeKey(activePlane))?.label
    ?? 'plano no disponible';

  return (
    <div className="app">
      {editing?.type === 'sketch' ? (
        // En modo boceto el editor 2D ocupa toda la ventana salvo el historial.
        <div style={{ gridArea: 'ribbon / ribbon / insp / insp', position: 'relative' }}>
          <SketchEditor sketch={editing} />
        </div>
      ) : (
        <>
          <Ribbon />
          <Navigator />
          <div className="view">
            <Viewport />
            <div className="view-badge" data-testid="view-info">
              <div><b>{result?.bodies.length ?? 0}</b> cuerpo(s) · <b>{totalVolume.toFixed(1)}</b> mm³</div>
              <div>Plano activo: <b>{activeLabel}</b></div>
              {(result?.faces.length ?? 0) > 0 && (
                <div>Hacé clic en una cara para bocetar sobre ella</div>
              )}
              <div>{rebuilding ? 'reconstruyendo…' : `${result?.totalMs.toFixed(0) ?? 0} ms`}</div>
            </div>
          </div>
          <Inspector />
        </>
      )}
      <Timeline />
      <DeleteDialog />
    </div>
  );
}
