/**
 * Persistencia local de diseños (IndexedDB).
 *
 * Sin dependencias: la API nativa alcanza y evita sumar peso al bundle.
 * Local primero a propósito; el esquema (un registro autocontenido por diseño,
 * con `updatedAt`) es el que haría falta para sincronizar con un servidor más
 * adelante sin migrar nada.
 */
import type { DesignDocument } from '../model/types';

const DB_NAME = 'ilusio';
const DB_VERSION = 1;
const STORE = 'designs';

export interface DesignRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** PNG en data URL para la galería. */
  thumbnail: string | null;
  doc: DesignDocument;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export const saveDesign = (record: DesignRecord) =>
  run('readwrite', (s) => s.put(record) as IDBRequest<IDBValidKey>).then(() => undefined);

export const loadDesign = (id: string) =>
  run<DesignRecord | undefined>('readonly', (s) => s.get(id));

export const deleteDesign = (id: string) =>
  run('readwrite', (s) => s.delete(id) as IDBRequest<undefined>);

/** Todos los diseños, del más reciente al más viejo, sin el documento completo. */
export async function listDesigns(): Promise<Omit<DesignRecord, 'doc'>[]> {
  const all = await run<DesignRecord[]>('readonly', (s) => s.getAll());
  return all
    .map(({ doc: _doc, ...meta }) => meta)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Espacio ocupado, para avisar antes de chocar con la cuota del navegador. */
export async function estimateUsage(): Promise<{ usedMB: number; quotaMB: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usedMB: usage / 1e6, quotaMB: quota / 1e6 };
}
