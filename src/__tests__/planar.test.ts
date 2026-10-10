/**
 * Descomposición del boceto en perfiles. El caso que motiva todo esto es el
 * triángulo partido por una línea: hasta que no se parten las curvas donde se
 * cruzan, los dos pedazos no se pueden extruir por separado.
 */
import { describe, expect, it } from 'vitest';
import { findFaces, splitAtIntersections } from '../kernel/planar';
import { findRegions, orderedRegions, type SolvedCurve } from '../kernel/sketch';

const line = (id: string, ax: number, ay: number, bx: number, by: number): SolvedCurve =>
  ({ id, kind: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by } });

const circle = (id: string, cx: number, cy: number, r: number): SolvedCurve =>
  ({ id, kind: 'circle', c: { x: cx, y: cy }, r });

const area = (f: { signedArea: number }) => Math.abs(f.signedArea);

describe('descomposición en perfiles', () => {
  it('un triángulo solo da una cara', () => {
    const faces = findFaces([
      line('a', 0, 0, 100, 0),
      line('b', 100, 0, 50, 80),
      line('c', 50, 80, 0, 0),
    ]);
    expect(faces).toHaveLength(1);
    expect(area(faces[0])).toBeCloseTo(4000, 6);
  });

  it('una línea que lo cruza lo parte en dos caras', () => {
    // Triángulo (0,0)-(100,0)-(50,80) y una línea del vértice de arriba al
    // medio de la base: dos mitades de 2000 cada una.
    const faces = findFaces([
      line('a', 0, 0, 100, 0),
      line('b', 100, 0, 50, 80),
      line('c', 50, 80, 0, 0),
      line('corte', 50, 80, 50, 0),
    ]);
    expect(faces).toHaveLength(2);
    expect(faces.map(area).sort((x, y) => x - y).map((a) => Math.round(a)))
      .toEqual([2000, 2000]);
  });

  it('la línea de corte parte también la base', () => {
    const pieces = splitAtIntersections([
      line('base', 0, 0, 100, 0),
      line('corte', 50, 80, 50, 0),
    ]);
    // La base queda en dos pedazos; la de corte toca por un extremo y sigue entera.
    expect(pieces.filter((p) => p.curve.id === 'base')).toHaveLength(2);
  });

  it('un rectángulo partido al medio da dos mitades', () => {
    const faces = findFaces([
      line('ab', 0, 0, 60, 0),
      line('bc', 60, 0, 60, 40),
      line('cd', 60, 40, 0, 40),
      line('da', 0, 40, 0, 0),
      line('corte', 30, 0, 30, 40),
    ]);
    expect(faces).toHaveLength(2);
    expect(faces.map(area).map((a) => Math.round(a))).toEqual([1200, 1200]);
  });

  it('dos círculos que se cruzan dan tres caras', () => {
    // Las dos lúnulas y la lente del medio.
    const faces = findFaces([circle('c1', 0, 0, 10), circle('c2', 12, 0, 10)]);
    expect(faces).toHaveLength(3);
  });

  it('un círculo dentro de otro sigue siendo un contorno con agujero', () => {
    const regions = findRegions(findFaces([
      circle('ext', 0, 0, 30),
      circle('int', 0, 0, 12),
    ]).map((f) => ({ segments: [], polyline: f.polyline, signedArea: f.signedArea })));
    expect(regions).toHaveLength(1);
    expect(regions[0].holes).toHaveLength(1);
  });

  it('una línea suelta no inventa ninguna cara', () => {
    expect(findFaces([line('suelta', 0, 0, 50, 0)])).toHaveLength(0);
  });

  it('un contorno abierto tampoco', () => {
    expect(findFaces([
      line('a', 0, 0, 50, 0),
      line('b', 50, 0, 50, 50),
    ])).toHaveLength(0);
  });

  it('las dos mitades reciben índices distintos y estables', () => {
    const regions = orderedRegions([
      line('ab', 0, 0, 60, 0),
      line('bc', 60, 0, 60, 40),
      line('cd', 60, 40, 0, 40),
      line('da', 0, 40, 0, 0),
      line('corte', 30, 0, 30, 40),
    ]);
    expect(regions.map((r) => r.index)).toEqual([0, 1]);
    // Ordenadas por centroide: primero la izquierda.
    expect(regions[0].centroid.x).toBeLessThan(regions[1].centroid.x);
    expect(regions.map((r) => Math.round(r.area))).toEqual([1200, 1200]);
  });
});
