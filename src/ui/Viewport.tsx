import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useDocument } from '../store/useDocument';
import { PLANES, to3d, type PlaneBasis } from '../kernel/shapes';
import { curveToPolyline, type IndexedRegion } from '../kernel/sketch';
import type { Canvas as CanvasRef, ProfileSelection } from '../model/types';

const COLORS = {
  background: 0x2b3137,
  body: 0xd9a441,
  edge: 0x1c2024,
  sketch: 0x4aa3ff,
  sketchUnderConstrained: 0x9aa7b4,
  grid: 0x3e4852,
  profileOn: 0x4aa3ff,
  profileOff: 0x7d8792,
  plane: 0x8f7fd6,
};

/** Capas de la escena que se regeneran por separado al cambiar el documento. */
interface Layers {
  bodies: THREE.Group;
  sketches: THREE.Group;
  canvases: THREE.Group;
  /** Perfiles clicables del feature que se está editando. */
  profiles: THREE.Group;
  /** Planos de construcción. */
  planes: THREE.Group;
}

/** Rectángulo semitransparente con borde, para ver dónde cae un plano. */
function planeMesh(basis: PlaneBasis, extent: number): THREE.Group {
  const group = new THREE.Group();
  const m = new THREE.Matrix4()
    .makeBasis(
      new THREE.Vector3(...basis.u),
      new THREE.Vector3(...basis.v),
      new THREE.Vector3(...basis.n),
    )
    .setPosition(new THREE.Vector3(...basis.o));

  const geom = new THREE.PlaneGeometry(extent * 2, extent * 2);
  geom.applyMatrix4(m);
  group.add(new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
    color: COLORS.plane, transparent: true, opacity: 0.12,
    side: THREE.DoubleSide, depthWrite: false,
  })));

  const border = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-extent, -extent, 0), new THREE.Vector3(extent, -extent, 0),
    new THREE.Vector3(extent, extent, 0), new THREE.Vector3(-extent, extent, 0),
    new THREE.Vector3(-extent, -extent, 0),
  ]);
  border.applyMatrix4(m);
  group.add(new THREE.Line(border, new THREE.LineBasicMaterial({ color: COLORS.plane })));
  return group;
}

/** Malla plana de un perfil (con sus agujeros) sobre el plano del boceto. */
function regionMesh(region: IndexedRegion, basis: PlaneBasis, selected: boolean): THREE.Mesh {
  const shape = new THREE.Shape(
    region.outer.polyline.map((p) => new THREE.Vector2(p.x, p.y)),
  );
  for (const hole of region.holes) {
    shape.holes.push(new THREE.Path(hole.polyline.map((p) => new THREE.Vector2(p.x, p.y))));
  }
  const geom = new THREE.ShapeGeometry(shape);
  // ShapeGeometry vive en XY local; lo llevamos al plano del boceto.
  geom.applyMatrix4(new THREE.Matrix4()
    .makeBasis(
      new THREE.Vector3(...basis.u),
      new THREE.Vector3(...basis.v),
      new THREE.Vector3(...basis.n),
    )
    .setPosition(new THREE.Vector3(...basis.o)));
  const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
    color: selected ? COLORS.profileOn : COLORS.profileOff,
    transparent: true,
    opacity: selected ? 0.45 : 0.18,
    side: THREE.DoubleSide,
    // Se dibujan por encima de los sólidos: si quedan tapados no se pueden ni
    // ver ni elegir, que es justo para lo que están.
    depthTest: false,
    depthWrite: false,
  }));
  mesh.renderOrder = 10;
  mesh.userData.regionIndex = region.index;
  return mesh;
}

function clear(group: THREE.Group) {
  for (const child of [...group.children]) {
    group.remove(child);
    const m = child as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  }
}

function buildCanvasMesh(canvas: CanvasRef, texture: THREE.Texture): THREE.Mesh {
  const basis = PLANES[canvas.plane];
  const aspect = (texture.image as HTMLImageElement).height / (texture.image as HTMLImageElement).width;
  const geom = new THREE.PlaneGeometry(canvas.width, canvas.width * aspect);
  const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
    map: texture, transparent: true, opacity: canvas.opacity,
    side: THREE.DoubleSide, depthWrite: false,
  }));
  // Orientamos el plano con la base del plano de boceto.
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(...basis.u),
    new THREE.Vector3(...basis.v),
    new THREE.Vector3(...basis.n),
  );
  mesh.quaternion.setFromRotationMatrix(m);
  mesh.rotateZ(canvas.rotation);
  mesh.position.set(...to3d(basis, { x: canvas.center[0], y: canvas.center[1] }));
  mesh.renderOrder = -1;
  return mesh;
}

export default function Viewport() {
  const mountRef = useRef<HTMLDivElement>(null);
  const layersRef = useRef<Layers | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const toggleProfileRef = useRef<((index: number) => void) | null>(null);
  const pickFaceRef = useRef<
    ((point: THREE.Vector3 | null, normal: THREE.Vector3 | null) => void) | null
  >(null);
  const textureCache = useRef(new Map<string, THREE.Texture>());

  const result = useDocument((s) => s.result);
  const canvases = useDocument((s) => s.doc.canvases);
  const fitNonce = useDocument((s) => s.fitNonce);
  const setThumbnailSource = useDocument((s) => s.setThumbnailSource);
  const selection = useDocument((s) => s.selection);
  const features = useDocument((s) => s.doc.features);
  const patchFeature = useDocument((s) => s.patchFeature);
  const setActivePlane = useDocument((s) => s.setActivePlane);

  // --- Escena (se monta una sola vez) ---
  useEffect(() => {
    const mount = mountRef.current!;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(COLORS.background);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 20000);
    camera.position.set(140, -160, 120);
    camera.up.set(0, 0, 1); // Z arriba, convención CAD

    // preserveDrawingBuffer para poder sacar la miniatura con toDataURL.
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(120, -140, 200);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-150, 120, 60);
    scene.add(fill);

    const grid = new THREE.GridHelper(500, 50, COLORS.grid, COLORS.grid);
    grid.rotation.x = Math.PI / 2;
    (grid.material as THREE.Material).opacity = 0.35;
    (grid.material as THREE.Material).transparent = true;
    scene.add(grid);
    scene.add(new THREE.AxesHelper(30));

    const layers: Layers = {
      bodies: new THREE.Group(), sketches: new THREE.Group(),
      canvases: new THREE.Group(), profiles: new THREE.Group(),
      planes: new THREE.Group(),
    };
    scene.add(
      layers.bodies, layers.sketches, layers.canvases, layers.profiles, layers.planes,
    );
    layersRef.current = layers;

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    /**
     * Encuadra la cámara sobre lo que haya en escena, manteniendo la dirección
     * de vista actual.
     */
    fitRef.current = () => {
      const box = new THREE.Box3();
      for (const g of [layers.bodies, layers.sketches, layers.canvases]) {
        if (g.children.length) box.expandByObject(g);
      }
      if (box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
      const dir = camera.position.clone().sub(controls.target).normalize();
      const distance = radius / Math.sin((camera.fov * Math.PI) / 360) * 1.25;
      controls.target.copy(center);
      camera.position.copy(center).addScaledVector(dir, distance);
      camera.near = Math.max(distance / 1000, 0.01);
      camera.far = distance * 100;
      camera.updateProjectionMatrix();
      controls.update();
    };

    /**
     * Orbitar termina disparando un `click`, así que distinguimos un clic real
     * de un arrastre por cuánto se movió el puntero.
     */
    let downAt: { x: number; y: number } | null = null;
    const isClick = (e: MouseEvent) =>
      downAt !== null && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 4;
    const onDown = (e: PointerEvent) => { downAt = { x: e.clientX, y: e.clientY }; };
    renderer.domElement.addEventListener('pointerdown', onDown);

    // Clic sobre un perfil: lo agrega o lo saca de la selección del feature.
    const raycaster = new THREE.Raycaster();
    const onClick = (e: MouseEvent) => {
      if (!isClick(e)) return;
      const group = layersRef.current?.profiles;
      if (!group || group.children.length === 0) return;
      const r = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      ), camera);
      const hit = raycaster.intersectObjects(group.children, false)[0];
      if (hit) toggleProfileRef.current?.(hit.object.userData.regionIndex as number);
    };

    // Clic sobre un cuerpo: si pegó en una cara plana, la deja como plano
    // activo, que es el gesto natural para seguir construyendo encima.
    const onFaceClick = (e: MouseEvent) => {
      if (!isClick(e)) return;
      const bodies = layersRef.current?.bodies;
      if (!bodies || layersRef.current!.profiles.children.length > 0) return;
      const r = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      ), camera);
      const meshes = bodies.children.filter((c) => (c as THREE.Mesh).isMesh);
      const hit = raycaster.intersectObjects(meshes, false)[0];
      pickFaceRef.current?.(hit ? hit.point : null, hit?.face?.normal ?? null);
    };
    renderer.domElement.addEventListener('click', onFaceClick);
    renderer.domElement.addEventListener('click', onClick);

    setThumbnailSource(() => {
      renderer.render(scene, camera);
      const src = renderer.domElement;
      const thumb = document.createElement('canvas');
      thumb.width = 320;
      thumb.height = Math.round((320 * src.height) / src.width) || 240;
      thumb.getContext('2d')?.drawImage(src, 0, 0, thumb.width, thumb.height);
      return thumb.toDataURL('image/jpeg', 0.7);
    });

    let raf = 0;
    const loop = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('click', onClick);
      renderer.domElement.removeEventListener('click', onFaceClick);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      layersRef.current = null;
      fitRef.current = null;
      setThumbnailSource(null);
    };
  }, [setThumbnailSource]);

  useEffect(() => { fitRef.current?.(); }, [fitNonce]);

  useEffect(() => { fitRef.current?.(); }, [fitNonce]);

  const hadGeometry = useRef(false);

  // --- Cuerpos y bocetos ---
  useEffect(() => {
    const layers = layersRef.current;
    if (!layers || !result) return;

    clear(layers.bodies);
    for (const body of result.bodies) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(body.mesh.positions, 3));
      geom.setIndex(new THREE.BufferAttribute(body.mesh.indices, 1));
      geom.computeVertexNormals();
      layers.bodies.add(new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
        color: COLORS.body, metalness: 0.15, roughness: 0.5,
      })));

      // Las aristas son lo que hace que una pieza se lea como pieza.
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.BufferAttribute(body.mesh.edges, 3));
      layers.bodies.add(new THREE.LineSegments(
        eg, new THREE.LineBasicMaterial({ color: COLORS.edge }),
      ));
    }

    clear(layers.sketches);
    for (const sk of result.sketches) {
      const basis = sk.basis;
      const color = sk.solved.underConstrained
        ? COLORS.sketchUnderConstrained : COLORS.sketch;
      const points: number[] = [];
      for (const curve of sk.solved.curves) {
        const poly = curveToPolyline(curve);
        for (let i = 0; i < poly.length - 1; i++) {
          points.push(...to3d(basis, poly[i]), ...to3d(basis, poly[i + 1]));
        }
      }
      if (points.length === 0) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
      layers.sketches.add(new THREE.LineSegments(
        g, new THREE.LineBasicMaterial({ color }),
      ));
    }

    // La primera vez que hay algo que mirar, encuadramos solos.
    const hasGeometry = layers.bodies.children.length > 0 || layers.sketches.children.length > 0;
    if (hasGeometry && !hadGeometry.current) fitRef.current?.();
    hadGeometry.current = hasGeometry;
  }, [result]);

  /**
   * Perfiles del boceto que alimenta el feature seleccionado. Sólo aparecen
   * cuando hay una extrusión o una revolución elegida, que es cuando sirven.
   */
  const active = selection.kind === 'feature'
    ? features.find((f) => f.id === selection.id)
    : undefined;
  const profileHost = active && (active.type === 'extrude' || active.type === 'revolve')
    ? active : undefined;

  useEffect(() => {
    toggleProfileRef.current = (index) => {
      if (!profileHost) return;
      const sketch = useDocument.getState().result?.sketches
        .find((s) => s.featureId === profileHost.sketchId);
      if (!sketch) return;
      const current = profileHost.profiles.mode === 'all'
        ? sketch.regions.map((r) => r.index)
        : profileHost.profiles.indices;
      const next = current.includes(index)
        ? current.filter((x) => x !== index)
        : [...current, index].sort((a, b) => a - b);
      const profiles: ProfileSelection = next.length === sketch.regions.length
        ? { mode: 'all' } : { mode: 'indices', indices: next };
      patchFeature(profileHost.id, { profiles });
    };
  }, [profileHost, patchFeature]);

  useEffect(() => {
    const layers = layersRef.current;
    if (!layers) return;
    clear(layers.profiles);
    if (!profileHost || !result) return;

    const sketch = result.sketches.find((s) => s.featureId === profileHost.sketchId);
    if (!sketch) return;
    for (const region of sketch.regions) {
      const on = profileHost.profiles.mode === 'all'
        || profileHost.profiles.indices.includes(region.index);
      layers.profiles.add(regionMesh(region, sketch.basis, on));
    }
  }, [profileHost, result]);

  /**
   * Traduce un impacto del raycaster a un índice de cara.
   *
   * Se compara contra las caras planas que ya enumeró el kernel: la que
   * contiene al punto y mira para el mismo lado que el triángulo que se tocó.
   */
  useEffect(() => {
    pickFaceRef.current = (point, normal) => {
      if (!point || !normal) return;
      const faces = result?.faces ?? [];
      const matches = faces
        .map((f, index) => {
          const n = new THREE.Vector3(...f.n);
          if (n.dot(normal) < 0.9) return null;
          const d = Math.abs(point.clone().sub(new THREE.Vector3(...f.o)).dot(n));
          return d < 1e-4 ? { index, d } : null;
        })
        .filter((m): m is { index: number; d: number } => m !== null)
        .sort((a, b) => a.d - b.d);

      if (matches.length > 0) setActivePlane({ kind: 'face', faceIndex: matches[0].index });
    };
  }, [result, setActivePlane]);

  // --- Planos de construcción ---
  useEffect(() => {
    const layers = layersRef.current;
    if (!layers) return;
    clear(layers.planes);
    for (const p of result?.planes ?? []) layers.planes.add(planeMesh(p.basis, p.extent));
  }, [result]);

  // --- Lienzos ---
  useEffect(() => {
    const layers = layersRef.current;
    if (!layers) return;
    clear(layers.canvases);
    const loader = new THREE.TextureLoader();
    for (const canvas of canvases) {
      if (!canvas.visible) continue;
      const cached = textureCache.current.get(canvas.id);
      if (cached?.image) {
        layers.canvases.add(buildCanvasMesh(canvas, cached));
      } else {
        loader.load(canvas.src, (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          textureCache.current.set(canvas.id, tex);
          if (layersRef.current) layersRef.current.canvases.add(buildCanvasMesh(canvas, tex));
        });
      }
    }
  }, [canvases]);

  return <div ref={mountRef} data-testid="viewport" style={{ position: 'absolute', inset: 0 }} />;
}
