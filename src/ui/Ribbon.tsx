import { useRef, useState } from 'react';
import { useDocument } from '../store/useDocument';

import PlanePicker from './PlanePicker';
import { importSvg } from '../io/svg';
import { downloadModel } from '../io/exportFile';
import Gallery from './Gallery';
import { ToolButton } from './ToolIcons';

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ribbon-group">
      <div className="row">{children}</div>
      <div className="label">{label}</div>
    </div>
  );
}

export default function Ribbon() {
  // El plano activo vive en el store: el visor también lo cambia cuando hacés
  // clic sobre una cara del cuerpo.
  const plane = useDocument((s) => s.activePlane);
  const setPlane = useDocument((s) => s.setActivePlane);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const svgInput = useRef<HTMLInputElement>(null);

  const doc = useDocument((s) => s.doc);
  const selection = useDocument((s) => s.selection);
  const editing = useDocument((s) => s.editingSketchId);
  const {
    newSketch, extrudeFrom, revolveFrom, addFillet, addChamfer, addCanvas, commit,
    undo, redo, editSketch, requestFit, rename, saveNow, newPlane,
  } = useDocument();
  const result = useDocument((s) => s.result);
  const saveState = useDocument((s) => s.saveState);

  const past = useDocument((s) => s.past.length);
  const future = useDocument((s) => s.future.length);

  const sketches = doc.features.filter((f) => f.type === 'sketch');
  // Boceto sobre el que actuarán extruir/revolución: el seleccionado o el último.
  const targetSketch =
    (selection.kind === 'feature' && sketches.find((s) => s.id === selection.id)?.id) ??
    sketches[sketches.length - 1]?.id;

  const onImage = async (file: File) => {
    const src = await new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result as string);
      r.readAsDataURL(file);
    });
    // Los lienzos todavía sólo van sobre los planos del origen.
    addCanvas(file.name, src, plane.kind === 'base' ? plane.plane : 'XY');
  };

  const onSvg = async (file: File) => {
    const sketch = importSvg(doc, await file.text(), plane, file.name);
    commit({ ...doc, features: [...doc.features, sketch], rollbackIndex: doc.features.length + 1 });
  };

  const onExport = async (format: 'step' | 'stl') => {
    setBusy(format);
    try {
      await downloadModel(result?.bodies ?? [], format, doc.name);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ribbon">
      <Group label="Diseño">
        <input
          type="text" value={doc.name} style={{ width: 140 }}
          data-testid="doc-name"
          onChange={(e) => rename(e.target.value)}
        />
        <ToolButton icon="gallery" label="Mis diseños" data-testid="btn-gallery" onClick={() => setGalleryOpen(true)} />
      </Group>
      <Group label="Plano activo">
        <PlanePicker
          value={plane}
          onChange={setPlane}
          data-testid="plane-select"
          style={{ width: 160 }}
        />
        <ToolButton
          icon="plane" label="Plano"
          data-testid="btn-plane"
          title="Plano de construcción desfasado del plano activo"
          onClick={() => newPlane(plane)}
        />
      </Group>

      <Group label="Crear">
        <ToolButton icon="sketch" label="Boceto" data-testid="btn-sketch" onClick={() => newSketch(plane)} />
        <ToolButton
          icon="extrude" label="Extruir"
          data-testid="btn-extrude"
          disabled={!targetSketch}
          onClick={() => targetSketch && extrudeFrom(targetSketch)}
        />
        <ToolButton
          icon="revolve" label="Revolución"
          data-testid="btn-revolve"
          disabled={!targetSketch}
          onClick={() => targetSketch && revolveFrom(targetSketch)}
        />
      </Group>

      <Group label="Modificar">
        <ToolButton icon="fillet" label="Empalme" data-testid="btn-fillet" onClick={addFillet} />
        <ToolButton icon="chamfer" label="Chaflán" data-testid="btn-chamfer" onClick={addChamfer} />
      </Group>

      <Group label="Insertar">
        <ToolButton icon="canvas" label="Lienzo" onClick={() => imageInput.current?.click()} />
        <ToolButton icon="svg" label="SVG" onClick={() => svgInput.current?.click()} />
        <input
          ref={imageInput} type="file" accept="image/*" hidden
          onChange={(e) => e.target.files?.[0] && onImage(e.target.files[0])}
        />
        <input
          ref={svgInput} type="file" accept=".svg,image/svg+xml" hidden
          onChange={(e) => e.target.files?.[0] && onSvg(e.target.files[0])}
        />
      </Group>

      <Group label="Exportar">
        <ToolButton
          icon="download" label={busy === 'step' ? '…' : 'STEP'}
          disabled={!result?.bodies.length || busy !== null} onClick={() => onExport('step')}
        />
        <ToolButton
          icon="download" label={busy === 'stl' ? '…' : 'STL'}
          disabled={!result?.bodies.length || busy !== null} onClick={() => onExport('stl')}
        />
      </Group>

      <Group label="Vista">
        <ToolButton icon="fit" label="Encuadrar" onClick={requestFit} title="Encuadrar todo (F)" />
      </Group>

      <Group label="Edición">
        <ToolButton icon="undo" label="" onClick={undo} disabled={past === 0} title="Deshacer (Ctrl+Z)" />
        <ToolButton icon="redo" label="" onClick={redo} disabled={future === 0} title="Rehacer (Ctrl+Y)" />
      </Group>

      {editing && (
        <Group label="Boceto">
          <ToolButton icon="check" label="Terminar boceto" className="active" onClick={() => editSketch(null)} />
        </Group>
      )}

      <div style={{ marginLeft: 'auto', alignSelf: 'center', paddingRight: 8 }} className="hint">
        <span
          data-testid="save-state"
          title="Los diseños se guardan solos en este navegador"
          onClick={() => void saveNow()}
          style={{ cursor: 'pointer' }}
        >
          {{ idle: '', saving: 'guardando…', saved: 'guardado', error: 'error al guardar' }[saveState]}
        </span>
      </div>

      {galleryOpen && <Gallery onClose={() => setGalleryOpen(false)} />}
    </div>
  );
}
