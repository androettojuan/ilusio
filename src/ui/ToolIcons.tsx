/**
 * Iconos de las herramientas.
 *
 * Dibujados a mano en SVG sobre una grilla de 20x20: con el nombre solo cuesta
 * encontrar la herramienta de un vistazo, y una fuente de iconos sería otra
 * dependencia para veinte dibujos simples.
 */
const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const DOT = { fill: 'currentColor', stroke: 'none' };

const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg width="17" height="17" viewBox="0 0 20 20" {...S} aria-hidden="true">{children}</svg>
);

/** Cuadrito de extremo, como los puntos del boceto. */
const End = ({ x, y }: { x: number; y: number }) => (
  <rect x={x - 1.6} y={y - 1.6} width={3.2} height={3.2} {...DOT} />
);

export const ICONS = {
  select: (
    <Icon><path d="M4 3 L4 15 L7.5 11.8 L10 16.5 L12.2 15.4 L9.8 10.9 L14.5 10.5 Z" /></Icon>
  ),
  line: (
    <Icon><line x1="4" y1="15" x2="16" y2="5" /><End x={4} y={15} /><End x={16} y={5} /></Icon>
  ),
  spline: (
    <Icon>
      <path d="M3 14 C 6 4, 9 16, 12 8 S 16 5, 17 6" />
      <End x={3} y={14} /><End x={12} y={8} /><End x={17} y={6} />
    </Icon>
  ),
  rect: (
    <Icon><rect x="3.5" y="5.5" width="13" height="9" /><End x={3.5} y={5.5} /><End x={16.5} y={14.5} /></Icon>
  ),
  circle: (
    <Icon><circle cx="10" cy="10" r="6.5" /><End x={10} y={10} /></Icon>
  ),
  arc: (
    <Icon><path d="M3.5 14 A 7.5 7.5 0 0 1 16.5 14" /><End x={3.5} y={14} /><End x={16.5} y={14} /></Icon>
  ),
  polygon: (
    <Icon><path d="M10 3.3 L16 7 L16 13 L10 16.7 L4 13 L4 7 Z" /></Icon>
  ),
  dimension: (
    <Icon>
      <line x1="4" y1="4" x2="4" y2="12" />
      <line x1="16" y1="4" x2="16" y2="12" />
      <line x1="4" y1="8" x2="16" y2="8" />
      <path d="M4 8 L7 6.3 L7 9.7 Z" {...DOT} />
      <path d="M16 8 L13 6.3 L13 9.7 Z" {...DOT} />
    </Icon>
  ),
  trim: (
    <Icon>
      <circle cx="5" cy="15" r="2" /><circle cx="5" cy="5" r="2" />
      <line x1="6.6" y1="13.8" x2="16" y2="5" />
      <line x1="6.6" y1="6.2" x2="11" y2="10" />
    </Icon>
  ),
  grid: (
    <Icon>
      <path d="M3 8 H17 M3 12 H17 M8 3 V17 M12 3 V17" strokeWidth={1} opacity={0.75} />
      <rect x="6.6" y="6.6" width="2.8" height="2.8" {...DOT} />
    </Icon>
  ),

  // --- Restricciones ---
  horizontal: (
    <Icon><line x1="3" y1="10" x2="17" y2="10" /><End x={3} y={10} /><End x={17} y={10} /></Icon>
  ),
  vertical: (
    <Icon><line x1="10" y1="3" x2="10" y2="17" /><End x={10} y={3} /><End x={10} y={17} /></Icon>
  ),
  coincident: (
    <Icon><circle cx="10" cy="10" r="4.5" /><circle cx="10" cy="10" r="1.6" {...DOT} /></Icon>
  ),
  parallel: (
    <Icon><line x1="4" y1="16" x2="10" y2="4" /><line x1="10" y1="16" x2="16" y2="4" /></Icon>
  ),
  perpendicular: (
    <Icon>
      <line x1="5" y1="16" x2="15" y2="16" /><line x1="7" y1="16" x2="7" y2="4" />
      <path d="M7 13 H10 V16" strokeWidth={1} />
    </Icon>
  ),
  equal: (
    <Icon><line x1="4" y1="7.5" x2="16" y2="7.5" /><line x1="4" y1="12.5" x2="16" y2="12.5" /></Icon>
  ),
  tangent: (
    <Icon><circle cx="10" cy="13" r="4.5" /><line x1="3" y1="8.5" x2="17" y2="8.5" /></Icon>
  ),
  symmetric: (
    <Icon>
      <line x1="10" y1="3" x2="10" y2="17" strokeDasharray="2 2" />
      <path d="M7 6 L3.5 10 L7 14 Z" /><path d="M13 6 L16.5 10 L13 14 Z" />
    </Icon>
  ),
  concentric: (
    <Icon><circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="3" /></Icon>
  ),
  midpoint: (
    <Icon>
      <line x1="3" y1="10" x2="17" y2="10" />
      <End x={3} y={10} /><End x={17} y={10} />
      <circle cx="10" cy="10" r="2" {...DOT} />
    </Icon>
  ),
  fix: (
    <Icon>
      <line x1="4" y1="14" x2="16" y2="14" />
      <path d="M6 17 L8 14 M10 17 L12 14 M14 17 L16 14" strokeWidth={1} />
      <circle cx="10" cy="10" r="2.2" {...DOT} />
    </Icon>
  ),

  // --- Modificar ---
  pattern_rect: (
    <Icon>
      <rect x="3" y="3" width="5" height="5" /><rect x="12" y="3" width="5" height="5" />
      <rect x="3" y="12" width="5" height="5" /><rect x="12" y="12" width="5" height="5" />
    </Icon>
  ),
  pattern_circ: (
    <Icon>
      <circle cx="10" cy="10" r="7" strokeDasharray="2 2" strokeWidth={1} />
      <circle cx="10" cy="3.5" r="1.8" {...DOT} /><circle cx="15.6" cy="13" r="1.8" {...DOT} />
      <circle cx="4.4" cy="13" r="1.8" {...DOT} />
    </Icon>
  ),
  offset: (
    <Icon>
      <path d="M4 15 L4 7 A 3 3 0 0 1 7 4 L16 4" />
      <path d="M8 15 L8 10 A 1 1 0 0 1 9 9 L16 9" strokeDasharray="2.5 2" />
    </Icon>
  ),
  prune: (
    <Icon>
      <rect x="3" y="3" width="3" height="3" {...DOT} /><rect x="14" y="4" width="3" height="3" {...DOT} />
      <rect x="4" y="14" width="3" height="3" {...DOT} /><rect x="13" y="13" width="3" height="3" {...DOT} />
      <path d="M8.5 8.5 L11.5 11.5 M11.5 8.5 L8.5 11.5" />
    </Icon>
  ),
  trash: (
    <Icon>
      <path d="M4 6 H16" /><path d="M8 6 V4 H12 V6" />
      <path d="M5.5 6 L6.5 17 H13.5 L14.5 6" />
      <path d="M9 9 V14 M11 9 V14" strokeWidth={1} />
    </Icon>
  ),

  // --- Cinta principal ---
  sketch: (
    <Icon>
      <path d="M3 17 L5 12 L14 3 L17 6 L8 15 Z" />
      <line x1="14" y1="3" x2="17" y2="6" />
    </Icon>
  ),
  extrude: (
    <Icon>
      <path d="M4 12 L10 9 L16 12 L10 15 Z" />
      <path d="M10 9 L10 4" /><path d="M7.5 6 L10 3.3 L12.5 6" />
    </Icon>
  ),
  revolve: (
    <Icon>
      <line x1="4" y1="3" x2="4" y2="17" strokeDasharray="2 2" />
      <path d="M8 15 A 5 7 0 0 1 8 5 L15 5 A 5 7 0 0 1 15 15 Z" />
    </Icon>
  ),
  fillet: (
    <Icon><path d="M4 3 V9 A 8 8 0 0 0 12 17 H17" /><path d="M4 17 H17" strokeDasharray="2 2" strokeWidth={1} opacity={0.6} /></Icon>
  ),
  chamfer: (
    <Icon><path d="M4 3 V8 L13 17 H17" /><path d="M4 17 H13" strokeDasharray="2 2" strokeWidth={1} opacity={0.6} /></Icon>
  ),
  plane: (
    <Icon><path d="M2 12 L9 7 L18 9 L11 14 Z" /><End x={9} y={7} /></Icon>
  ),
  canvas: (
    <Icon>
      <rect x="3" y="4.5" width="14" height="11" />
      <circle cx="7.5" cy="8.5" r="1.3" {...DOT} />
      <path d="M3 13 L8 9.5 L12 13 L14.5 11 L17 13" />
    </Icon>
  ),
  svg: (
    <Icon>
      <path d="M4 16 C 7 6, 13 16, 16 6" />
      <End x={4} y={16} /><End x={16} y={6} />
    </Icon>
  ),
  fit: (
    <Icon>
      <path d="M3 7 V3 H7 M13 3 H17 V7 M17 13 V17 H13 M7 17 H3 V13" />
      <rect x="7.5" y="7.5" width="5" height="5" strokeWidth={1} />
    </Icon>
  ),
  undo: (
    <Icon><path d="M7 6 L3.5 9.5 L7 13" /><path d="M3.5 9.5 H12 A 4.5 4.5 0 0 1 12 18.5 H8" /></Icon>
  ),
  redo: (
    <Icon><path d="M13 6 L16.5 9.5 L13 13" /><path d="M16.5 9.5 H8 A 4.5 4.5 0 0 0 8 18.5 H12" /></Icon>
  ),
  gallery: (
    <Icon>
      <rect x="2.5" y="4" width="6.5" height="6.5" /><rect x="11" y="4" width="6.5" height="6.5" />
      <rect x="2.5" y="12.5" width="6.5" height="5" /><rect x="11" y="12.5" width="6.5" height="5" />
    </Icon>
  ),
  download: (
    <Icon><path d="M10 3 V12" /><path d="M6.5 9 L10 12.5 L13.5 9" /><path d="M4 15 V17 H16 V15" /></Icon>
  ),
  check: (
    <Icon><path d="M4 10.5 L8 14.5 L16 5.5" strokeWidth={2} /></Icon>
  ),
} as const;

export type IconName = keyof typeof ICONS;

/** Botón con icono y texto, que es como se encuentran las herramientas rápido. */
export function ToolButton({ icon, label, ...rest }: {
  icon?: IconName;
  label: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, ...rest.style }}>
      {icon && ICONS[icon]}
      {label}
    </button>
  );
}
