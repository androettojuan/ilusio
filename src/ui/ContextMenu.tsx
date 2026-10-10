import { useEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  onClick: () => void;
  /** Separador visual encima de este ítem. */
  divider?: boolean;
  danger?: boolean;
  disabled?: boolean;
}

export interface MenuAnchor { x: number; y: number }

/** Menú contextual posicionado en el puntero, que se cierra solo al perder foco. */
export default function ContextMenu({ anchor, items, onClose }: {
  anchor: MenuAnchor;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(anchor);

  // Si no entra en la ventana, se corre para adentro.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(anchor.x, window.innerWidth - r.width - 8),
      y: Math.min(anchor.y, window.innerHeight - r.height - 8),
    });
  }, [anchor.x, anchor.y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // `capture` para cerrarlo antes de que el clic haga otra cosa.
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      data-testid="context-menu"
      style={{
        position: 'fixed', left: pos.x, top: pos.y, zIndex: 100,
        background: 'var(--panel-2)', border: '1px solid var(--line)',
        borderRadius: 6, padding: 4, minWidth: 190,
        boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => (
        <div key={i}>
          {item.divider && (
            <div style={{ height: 1, background: 'var(--line)', margin: '4px 2px' }} />
          )}
          <button
            data-testid={`menu-${item.label}`}
            disabled={item.disabled}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              background: 'none', border: 'none', borderRadius: 4,
              padding: '5px 8px',
              color: item.disabled ? 'var(--muted)' : item.danger ? 'var(--danger)' : 'inherit',
            }}
            onClick={() => { item.onClick(); onClose(); }}
          >{item.label}</button>
        </div>
      ))}
    </div>
  );
}
