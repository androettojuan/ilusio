import type { P2 } from '../kernel/sketch';
import type { Dimension } from '../model/dimensions';

/** Separación por defecto entre la geometría y la línea de cota, en píxeles. */
const GAP = 26;
const ARROW = 7;

const sub = (a: P2, b: P2): P2 => ({ x: a.x - b.x, y: a.y - b.y });
const norm = (v: P2): P2 => {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
};

function arrow(at: P2, dir: P2, color: string) {
  const n = { x: -dir.y, y: dir.x };
  const back = { x: at.x - dir.x * ARROW, y: at.y - dir.y * ARROW };
  return (
    <polygon
      points={[
        `${at.x},${at.y}`,
        `${back.x + n.x * 3},${back.y + n.y * 3}`,
        `${back.x - n.x * 3},${back.y - n.y * 3}`,
      ].join(' ')}
      fill={color}
    />
  );
}

/**
 * Una cota dibujada.
 *
 * Trabaja en píxeles: recibe los extremos ya proyectados a pantalla, así el
 * grosor de las líneas, las flechas y el texto no cambian con el zoom.
 */
export default function DimensionGlyph({
  dim, a, b, vertex, label, selected, preview, onPick, onEdit,
}: {
  dim: Dimension;
  a: P2;
  b: P2;
  vertex?: P2;
  label: P2;
  selected: boolean;
  /** Todavía no está confirmada: se dibuja en verde y no recibe clics. */
  preview?: boolean;
  onPick: (e: React.PointerEvent) => void;
  onEdit: () => void;
}) {
  const color = preview ? '#8ed14f' : selected ? 'var(--accent)' : '#c8a24a';
  const dir = norm(sub(b, a));
  const perp = { x: -dir.y, y: dir.x };

  const body = () => {
    if (dim.kind === 'angle' && vertex) {
      // Arco entre las dos líneas, con el radio dado por dónde quedó el texto.
      const r = Math.max(26, Math.hypot(label.x - vertex.x, label.y - vertex.y));
      const a0 = Math.atan2(a.y - vertex.y, a.x - vertex.x);
      const a1 = Math.atan2(b.y - vertex.y, b.x - vertex.x);
      let span = a1 - a0;
      while (span <= -Math.PI) span += 2 * Math.PI;
      while (span > Math.PI) span -= 2 * Math.PI;
      const p0 = { x: vertex.x + r * Math.cos(a0), y: vertex.y + r * Math.sin(a0) };
      const p1 = { x: vertex.x + r * Math.cos(a0 + span), y: vertex.y + r * Math.sin(a0 + span) };
      return (
        <>
          <path
            d={`M ${p0.x} ${p0.y} A ${r} ${r} 0 0 ${span > 0 ? 1 : 0} ${p1.x} ${p1.y}`}
            fill="none" stroke={color} strokeWidth={1}
          />
          {arrow(p0, norm({ x: -Math.sin(a0) * Math.sign(span), y: Math.cos(a0) * Math.sign(span) }), color)}
          {arrow(p1, norm({ x: Math.sin(a0 + span) * Math.sign(span), y: -Math.cos(a0 + span) * Math.sign(span) }), color)}
        </>
      );
    }

    if (dim.kind === 'radius' || dim.kind === 'diameter') {
      // Línea desde el centro (o de lado a lado en un diámetro) hasta el borde,
      // más una guía hasta la etiqueta si quedó lejos.
      const farAway = Math.hypot(label.x - b.x, label.y - b.y) > 20;
      return (
        <>
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={1} />
          {arrow(b, dir, color)}
          {dim.kind === 'diameter' && arrow(a, { x: -dir.x, y: -dir.y }, color)}
          {farAway && (
            <line
              x1={b.x} y1={b.y} x2={label.x} y2={label.y}
              stroke={color} strokeWidth={0.7} opacity={0.6}
            />
          )}
        </>
      );
    }

    // Distancia: líneas de referencia + línea de cota con flechas.
    // La línea de cota pasa por donde quedó la etiqueta, como en un plano de
    // verdad; si no, el número flota suelto lejos de su cota.
    const along = (label.x - a.x) * perp.x + (label.y - a.y) * perp.y;
    const gap = Math.abs(along) > 1 ? along : GAP;
    const off = { x: perp.x * gap, y: perp.y * gap };
    const a2 = { x: a.x + off.x, y: a.y + off.y };
    const b2 = { x: b.x + off.x, y: b.y + off.y };
    // El texto corta la línea de cota en dos tramos en vez de taparla.
    const half = dim.text.length * 4 + 6;
    const t = ((label.x - a2.x) * dir.x + (label.y - a2.y) * dir.y);
    const cutA = { x: a2.x + dir.x * (t - half), y: a2.y + dir.y * (t - half) };
    const cutB = { x: a2.x + dir.x * (t + half), y: a2.y + dir.y * (t + half) };
    const splits = t > half && t < Math.hypot(b2.x - a2.x, b2.y - a2.y) - half;

    return (
      <>
        <line x1={a.x} y1={a.y} x2={a2.x} y2={a2.y} stroke={color} strokeWidth={0.7} opacity={0.6} />
        <line x1={b.x} y1={b.y} x2={b2.x} y2={b2.y} stroke={color} strokeWidth={0.7} opacity={0.6} />
        {splits ? (
          <>
            <line x1={a2.x} y1={a2.y} x2={cutA.x} y2={cutA.y} stroke={color} strokeWidth={1} />
            <line x1={cutB.x} y1={cutB.y} x2={b2.x} y2={b2.y} stroke={color} strokeWidth={1} />
          </>
        ) : (
          <line x1={a2.x} y1={a2.y} x2={b2.x} y2={b2.y} stroke={color} strokeWidth={1} />
        )}
        {arrow(a2, { x: -dir.x, y: -dir.y }, color)}
        {arrow(b2, dir, color)}
      </>
    );
  };

  return (
    <g data-testid={`dim-${dim.id}`} data-value={dim.value}>
      {body()}
      {/* El texto es el blanco de clic: seleccionar y editar. */}
      <rect
        x={label.x - dim.text.length * 4 - 5} y={label.y - 9}
        width={dim.text.length * 8 + 10} height={18}
        rx={3}
        fill="none"
        stroke={selected && !preview ? 'var(--accent)' : 'transparent'}
        pointerEvents={preview ? 'none' : 'all'}
        style={{ cursor: 'pointer' }}
        onPointerDown={onPick}
        onDoubleClick={onEdit}
      />
      <text
        x={label.x} y={label.y + 4}
        textAnchor="middle" fontSize={12} fill={color}
        pointerEvents={preview ? 'none' : 'all'}
        style={{ cursor: 'pointer', userSelect: 'none' }}
        onPointerDown={onPick}
        onDoubleClick={onEdit}
      >{dim.text}</text>
    </g>
  );
}
