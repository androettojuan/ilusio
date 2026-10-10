import { useState } from 'react';
import ContextMenu, { type MenuAnchor, type MenuItem } from './ContextMenu';
import { featureMenuItems } from './featureMenu';
import type { Feature } from '../model/types';

/**
 * Menú contextual de features, listo para usar.
 *
 * Devuelve el handler que hay que colgar del `onContextMenu` y el elemento a
 * renderizar. Lo usan el navegador y el historial con el mismo comportamiento.
 */
export function useFeatureMenu() {
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; items: MenuItem[] } | null>(null);

  const open = (items: MenuItem[]) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ anchor: { x: e.clientX, y: e.clientY }, items });
  };

  const onContextMenu = (feature: Feature) => open(featureMenuItems(feature));

  const element = menu && (
    <ContextMenu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} />
  );

  return { onContextMenu, openMenu: open, element };
}
