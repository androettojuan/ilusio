# Ilusio

CAD paramétrico en el navegador, open source. Un subconjunto deliberadamente
pequeño de Fusion 360: boceto con restricciones, extruir, revolución, empalme,
lienzos de referencia, importación de SVG e historial editable.

```
npm install
npm run dev          # http://localhost:5173
npm test             # pruebas de la lógica geométrica (rápidas)
npm run test:kernel  # validación de OCCT y del solver, sin navegador
```

## Licencia

Ilusio es [LGPL-3.0-or-later](LICENSE).

El motivo es que los dos motores que hacen el trabajo pesado ya son copyleft
débil: OpenCascade es LGPL-2.1 y PlaneGCS es LGPL-2.0-or-later. LGPL-3.0 es
compatible con ambos y no obliga a quien use este código a abrir el suyo.

## Arquitectura

Escribir un kernel geométrico desde cero son años de trabajo. Reutilizamos los
mismos motores que usa FreeCAD, compilados a WebAssembly:

| Capa | Qué resuelve | Librería |
|---|---|---|
| Solver 2D | Restricciones del boceto: coincidente, tangente, paralela, igual, simetría, cotas… | [`@salusoft89/planegcs`](https://github.com/Salusoft89/planegcs) (PlaneGCS de FreeCAD) |
| Kernel B-Rep | Extruir, revolución, empalme, chaflán, booleanas, STEP/STL | [`opencascade.js`](https://github.com/donalffons/opencascade.js) (OCCT 7.6) |
| Render | Visor 3D | Three.js |

Lo que construimos nosotros es la UI, el modelo de documento paramétrico, el
historial y la persistencia.

### La pieza central: el documento es una lista de features

```
Documento = { parámetros, features[], lienzos[], rollbackIndex }
features[] = [ plano, boceto, extrusión, revolución, empalme, chaflán, … ]
```

Cada feature es un objeto serializable con sus parámetros, **nunca una malla**.
Reconstruir el modelo es recorrer la lista: el solver resuelve cada boceto, se
detectan los perfiles cerrados y OCCT encadena las operaciones
([`src/kernel/rebuild.ts`](src/kernel/rebuild.ts)). De ese único diseño salen
gratis el historial editable de la barra inferior, el undo, los parámetros y la
base de datos.

El boceto se guarda directamente en el formato que consume PlaneGCS, así que no
hay capa de traducción entre lo que se dibuja y lo que se resuelve.

### De boceto a sólido: la descomposición en perfiles

Encadenar curvas por sus extremos no alcanza. Una línea que cruza por el medio
de un triángulo lo parte en dos, y ninguno de los dos pedazos es una cadena de
curvas completas. Lo que se hace ([`src/kernel/planar.ts`](src/kernel/planar.ts)):

1. Se parten todas las curvas donde se cruzan entre sí. Los cortes se calculan
   una sola vez y se agrupan, así todas las curvas que pasan por un cruce usan
   exactamente el mismo punto; si cada una se partiera en el punto que calculó
   por su cuenta, los extremos quedarían a un micrón y el grafo no cerraría.
2. Con los pedazos se arma un grafo plano de semiaristas, ordenadas por ángulo
   en cada nodo.
3. Se recorre girando siempre al siguiente en sentido horario desde el gemelo
   del que llegó: cada vuelta encierra una cara mínima.
4. Las caras de área positiva son el interior; la negativa es el contorno de
   afuera y se descarta.

Después `findRegions` decide por contención cuál es contorno y cuál agujero, y
cada perfil recibe su índice estable por centroide.

### Mapa del código

| Carpeta | Qué hay |
|---|---|
| `src/model/` | Tipos del documento, edición de bocetos, recortar |
| `src/kernel/` | Carga de OCCT y PlaneGCS, perfiles, operaciones 3D, reconstrucción |
| `src/store/` | Estado, undo/redo, autoguardado |
| `src/ui/` | Cinta, navegador, historial, inspector, visor y editor 2D |
| `src/io/` | Importación de SVG, exportación STEP/STL |
| `src/db/` | Persistencia en IndexedDB |

## Qué funciona

- **Boceto**: línea encadenada, **curva por puntos**, rectángulo, círculo, arco,
  polígono regular. Al dibujar se ve adónde va a caer el clic: cuadro amarillo
  si engancha con un punto existente (y lo reutiliza, cerrando el perfil), aspa
  verde si cae sobre una curva (y queda restringido a ella), triángulo verde si
  cae sobre el **punto medio** de una línea, rombo azul si cae sobre un vértice
  de la cuadrícula. La lectura de coordenadas muestra adónde
  va a caer el clic, no dónde está el mouse. Un trazo termina solo al enganchar
  con geometría que ya estaba, así que no hace falta volver al primer punto
  para cerrar contra otra curva.
- **Restricciones**: horizontal, vertical, coincidente, paralela, perpendicular,
  colineal, igual, tangente, simetría, concéntrica, punto medio y fijar.
  Además, **arrastrar un punto encima de otro los vuelve coincidentes**, y
  soltarlo sobre una curva lo deja apoyado en ella.
- **Medida al dibujar**: mientras trazás una línea o un círculo aparece su
  medida en vivo y podés escribirla directamente. La geometría se crea con ese
  valor exacto y queda acotada.
- **Cota** (una sola herramienta, en Crear): elegís qué medir y ella infiere la
  cota que corresponde — una línea da su largo, un círculo su diámetro, un arco
  su radio, dos puntos la distancia, un punto y una línea la perpendicular, dos
  líneas el ángulo (o la separación si son paralelas). La cota se dibuja en
  verde siguiendo al cursor para que la ubiques donde querés, y recién ahí
  escribís la medida. Una vez puesta: doble clic la cambia y se arrastra para
  acomodarla. Con sus prefijos de plano (Ø, R, °) y la línea de cota cortada
  donde va el número.
- **Selección por ventana**: arrastrando con el botón izquierdo sobre una zona
  vacía. De izquierda a derecha entra sólo lo que quede entero adentro (caja
  azul llena); de derecha a izquierda, todo lo que la ventana toque (caja verde
  punteada). `Ctrl` suma a lo ya seleccionado y `Escape` cancela.
- **`Shift` fija el trazo** a la horizontal o la vertical mientras dibujás.
- **Modificar boceto**: **empalme y chaflán** sobre una esquina (elegís las dos
  líneas que se tocan), simetría (deja la restricción puesta, no es una copia
  muerta), patrón rectangular, patrón circular, desfase, recortar (también
  sobre curvas por puntos), borrar. Al borrar geometría se van también los
  puntos que la sostenían; los que ya estuvieran sueltos se marcan en rojo y
  "Limpiar sueltos" los saca.
- **Planos**: los tres del origen, planos de construcción desfasados (de otro
  plano o de una cara) y **cualquier cara plana del cuerpo**. Se elige en el
  selector o haciendo clic directamente sobre la cara en el visor.
- **3D**: extruir (con simétrica y booleanas), revolución, empalme, chaflán.
  Al crear una, el feature queda **en curso**: elegís los perfiles (clic sobre
  el perfil en el visor o en la lista), el campo de la medida arranca enfocado,
  y confirmás con Aceptar o Enter. Así un mismo boceto da varias extrusiones de
  distinta altura, una por vez.
- **Referencias**: lienzos (imágenes sobre un plano) e importación de SVG.
- **Historial**: barra inferior con marcador de retroceso, reordenar arrastrando,
  suprimir, y el feature que falla se marca en rojo sin tumbar la reconstrucción.
- **Editar y borrar cualquier feature**: clic derecho sobre él en el navegador o
  en el historial (editar, mostrar/ocultar, suprimir, retroceder hasta ahí,
  eliminar), doble clic para editarlo, `Supr` para borrar el seleccionado, y
  todos sus parámetros en el panel de propiedades. Borrar algo de lo que
  dependen otros features avisa y deja elegir si se los lleva o no.
- **Visibilidad**: ojito por boceto, cuerpo y lienzo.
- **Persistencia**: autoguardado en IndexedDB con miniatura, galería de diseños.
- **Exportación**: STEP y STL.

### Precisión verificada

Volúmenes medidos contra el valor teórico, idénticos en Node y en el navegador:

| Caso | Obtenido | Esperado |
|---|---|---|
| Extrusión 100 × 75 × 10 | 75000.0 mm³ | 75000 |
| Con agujero Ø30 | 67931.4 mm³ | 67931.4 |
| Empalme r=5 en 4 aristas | 79570.80 mm³ | 79570.80 |
| Revolución 360° | 1256637.06 mm³ | 1256637.06 (Pappus) |
| Patrón 4×2 de cilindros | 25132.7 mm³ | 25132.7 |
| Perfil recortado con muesca semicircular | 71465.7 mm³ | 71465.7 |
| Dos extrusiones del mismo boceto (2 perfiles h=20 / 1 perfil h=5) | 12566.4 y 1570.8 mm³ | 12566.4 y 1570.8 |
| Cilindro Ø24×15 bocetado sobre la cara superior de una caja 60×40×20 | 54785.8 mm³ | 54785.8 |
| Agujero Ø12 cortado desde un plano desfasado 40 mm | 52523.9 mm³ | 52523.9 |

Latencia tras cambiar un parámetro: **solver ~2 ms, sólido ~100 ms**. La primera
carga tarda unos segundos por el `.wasm` de OCCT.

## Decisiones y trampas encontradas

- **`opencascade.js@beta`, no `@latest`.** La 1.1.1 (etiquetada `latest`, de
  2021) tiene el binding de `Standard_CString` roto: `STEPControl_Writer.Write()`
  escribe en un archivo de nombre corrupto. La `2.0.0-beta` trae OCCT 7.6,
  tipados TypeScript completos y lo arregla.
- **Los `.wasm` se sirven desde `/public/wasm`**, no por el bundler: el de OCCT
  pesa 50 MB. Los copia `scripts/copy-wasm.sh`, enganchado a `postinstall`.
- **`TopExp_Explorer` repite cada arista** una vez por cara adyacente. Hay que
  deduplicar con `IsSame` antes de pasárselas al empalme
  (`TopTools_IndexedMapOfShape` no está expuesto en este build).
- **Los enums de OCCT no existen todos en runtime** y los tipados generados
  declaran los parámetros con el tipo del contenedor en vez del miembro. Ambas
  cosas se puentean con el helper `enumVal` en `src/kernel/shapes.ts`.
- **Las normales las calcula Three.js.** Cada cara de OCCT trae su propio juego
  de nodos, así que `computeVertexNormals()` da plano entre caras y suave dentro
  de una cara curva, que es justo lo que se quiere en CAD.
- **El editor de bocetos es SVG, no Three.js.** Para geometría plana, cotas y
  glifos de restricción, el SVG da líneas nítidas a cualquier zoom y el manejo
  del puntero es directo. El boceto se edita siempre de frente al plano.
- **"Punto medio" se expresa como simetría.** `midpoint_on_line_pppp` de PlaneGCS
  necesitaría una línea degenerada y el solver no converge; "A y B simétricos
  respecto de P" es la misma condición y sí converge.
- **La curva por puntos no pasa por PlaneGCS.** El solver sólo maneja B-splines
  por polos, y una curva que *no* pasa por los puntos que marcaste no es lo que
  uno espera al dibujar punto por punto. Guardamos los puntos como puntos
  normales del boceto (arrastrables y restringibles) y la curva se recalcula a
  partir de ellos: en pantalla con una Catmull-Rom centrípeta, y en el sólido
  con `GeomAPI_PointsToBSpline`, que interpola con un error de ~1e-13.
- **El empalme del boceto deja tangencia y radio, no un arco suelto.** Las
  líneas se acortan hasta los puntos de tangencia y el arco se ata con
  `tangent_la` en las dos más su radio, así sigue empalmando si después se
  mueven las líneas.
- **El orden de las primitivas importa para PlaneGCS.** Resuelve las
  referencias a medida que recorre la lista, así que una línea que aparece
  antes que sus puntos falla con "sketch object not found". Editar el boceto
  puede romper ese orden sin que se note (el empalme reapunta líneas viejas a
  puntos nuevos), así que `orderForSolver` lo garantiza en un solo lugar en vez
  de confiar en que cada función de edición lo respete.
- **El punto medio deja restricción, no sólo posición.** Enganchar al medio y
  que después la línea cambie dejaría el punto descentrado. Se guarda como "los
  dos extremos son simétricos respecto de este punto", así sigue siendo el
  medio aunque la línea se mueva, rote o cambie de largo.
- **Un gesto es un paso de historial, no cien.** Arrastrar un punto dispara un
  cambio por cada movimiento del mouse; sin agruparlos, deshacer obliga a
  apretar Ctrl+Z una vez por píxel. `commit` recibe una clave de gesto y
  reemplaza el estado en vez de apilar mientras la clave no cambie.
- **`Ctrl` suma a la selección, no `Shift`.** Shift queda libre para fijar el
  trazo a un eje, que es para lo que se usa mientras se dibuja.
- **Con Shift, el enganche no puede sacar el trazo del eje.** Si engancharía
  fuera, se respeta la posición sobre el eje y se pierde la restricción que
  habría agregado: lo que el usuario pidió explícitamente manda.
- **Los puntos se agarran donde se ven, no donde están guardados.** Las
  coordenadas de una primitiva son la semilla del solver; en cuanto hay
  restricciones dejan de coincidir con el resultado. Buscar contra la semilla
  hacía que los puntos no se pudieran agarrar (`snapPoint` recibe las
  posiciones resueltas).
- **Arrastrar para unir deja una restricción, no una casualidad.** Si sólo se
  movieran las coordenadas, el próximo arrastre rompería la unión.
- **Colineal se expresa con dos "punto sobre línea".** PlaneGCS no tiene una
  restricción propia, pero el par dice exactamente lo mismo.
- **Una sola herramienta de cota, no un botón por tipo.** Tener Cota, Ángulo,
  Radio y Diámetro por separado obliga al usuario a saber de antemano qué va a
  medir. Mirando los tipos de lo que eligió, la herramienta lo deduce sola, que
  es como funciona en cualquier CAD.
- **La línea de cota pasa por donde quedó la etiqueta**, y se corta para dejar
  lugar al número. Si el número flota lejos de su cota o la tapa, el dibujo
  deja de leerse.
- **Los botones llevan icono dibujado a mano en SVG.** Con el nombre solo cuesta
  encontrar la herramienta de un vistazo, y una fuente de iconos sería otra
  dependencia para veinte dibujos simples (`src/ui/ToolIcons.tsx`).
- **Una cota que no se ve no sirve.** Aplicarla y que no aparezca nada deja al
  usuario sin saber qué midió ni cómo corregirlo. Por eso se dibujan con sus
  líneas de referencia, flechas y número, y el número es el blanco de clic para
  editarla o borrarla.
- **El corrimiento de la etiqueta se guarda en el boceto, no en la restricción.**
  Las restricciones se le pasan tal cual a PlaneGCS; meterles datos de dibujo es
  pedir problemas.
- **Una extrusión sin perfiles elegidos no es un error.** Es el estado normal
  mientras se está armando: no construye nada y espera.
- **La cuadrícula engancha por vértice, no por eje.** Si se enganchara cada
  coordenada por separado, todo lo que pasara cerca de una línea saltaría al
  vértice. Midiendo la distancia al vértice, sólo engancha cuando uno
  efectivamente se está apoyando ahí. El paso es siempre un valor redondo
  (1, 2, 5, 10, 20, 50…) que deje al menos 70 px entre líneas; se apaga con la
  tecla G.
- **El enganche a la cuadrícula no deja restricción.** La cuadrícula depende del
  zoom: atar un punto a ella sería atarlo a algo que cambia solo. Es ayuda para
  dibujar, nada más; para fijar la posición están la cota y "Fijar".
- **Las dos convenciones de ventana existen por algo.** "Sólo lo entero" sirve
  para sacar una figura completa sin tocar lo que la rodea; "todo lo que toque"
  sirve para agarrar algo que cruza la pantalla sin tener que encuadrarlo. Es la
  convención de AutoCAD y Fusion, y vale la pena respetarla.
- **El plano de un boceto es una referencia, no un valor.** Puede apuntar a un
  plano del origen, a un plano de construcción o a una cara. El kernel la
  resuelve durante la reconstrucción, así que mover un plano desfasado arrastra
  todo lo que cuelga de él, y bocetar sobre una cara sigue a la cara cuando
  cambia la pieza.
- **El origen de una cara va en su centro, no en el del plano infinito.** Si no,
  bocetar sobre una cara lejos del origen te deja dibujando en otro lado.
- **Un plano de construcción es un feature del historial**, no una propiedad del
  boceto: así se recalcula solo cuando cambia aquello de lo que cuelga y se
  puede reusar en varios bocetos.
- **Al borrar un boceto se puede elegir qué pasa con lo que lo usaba.** Llevarse
  todo no siempre es lo que uno quiere: a veces conviene dejar la extrusión en
  rojo y reapuntarla a otro perfil. El diálogo ofrece las dos salidas en vez de
  decidir por el usuario.
- **El borrado se cascadea en los dos sentidos.** La cascada natural elimina lo
  que *referencia* a lo borrado (una cota pierde su punto y se va). Pero un
  punto no referencia a su curva, así que hace falta además recoger los puntos
  que ya no sostienen ninguna geometría. El recorte es la excepción: quita la
  curva vieja sin podar, porque reutiliza esos mismos puntos al rearmar los
  pedazos.
- **Al recortar una curva por puntos, el pedazo se reconstruye.** No se puede
  guardar "la curva original entre t=0,3 y t=0,8" porque PlaneGCS y OCCT la
  parametrizan distinto. En su lugar se vuelve a muestrear el tramo que queda y
  se simplifica con Douglas-Peucker: la desviación queda por debajo de 0,5 ‰ del
  tamaño de la curva, y los puntos originales que sobreviven conservan su id,
  así la geometría enganchada a un extremo no se suelta.
- **Los perfiles se numeran por centroide.** Si el índice saliera del orden de
  dibujo, agregar geometría en otra parte del boceto le cambiaría el perfil a
  una extrusión ya hecha.
- **El SVG se importa con la geometría del navegador.** `getTotalLength` /
  `getPointAtLength` sobre el elemento evitan escribir un parser de paths, y
  Douglas-Peucker devuelve los tramos rectos a dos puntos.

## Limitaciones conocidas

- **Topological naming.** La selección de aristas y de caras por índice usa un
  orden determinista (por punto medio o centroide), así que aguanta mientras la
  topología no cambie. Si cambia, un boceto apoyado en "la cara 3" puede saltar
  a otra. Las selecciones por regla (`todas`, `sólo verticales`) son inmunes.
- **Los patrones de boceto son copias**, no features paramétricos: cambiar el
  original no actualiza las copias. La simetría sí queda ligada.
- **La descomposición en perfiles es O(n²) en cantidad de curvas.** Se cruzan
  todas contra todas sin índice espacial. Con bocetos normales y SVG de un par
  de cientos de segmentos va en milisegundos; con miles se va a notar.
- **El kernel corre en el hilo principal.** Una reconstrucción pesada congela la
  UI unos cientos de milisegundos.
- **Las imágenes de lienzo se guardan como data URL** dentro del documento, lo
  que infla la base. Deberían ir a un almacén de blobs aparte.

## Pendiente

- Recortar el `.wasm` con un build a medida de opencascade.js (se usa un 5 % de
  OCCT); debería bajar de 50 MB a unos pocos.
- Mover el kernel a un Web Worker.
- Más herramientas de boceto: elipse, ranura, texto, alargar, partir, escala,
  mover/copiar.
- Cotas atadas a parámetros con nombre (`ancho = 80`), que PlaneGCS ya soporta.
- Selección de aristas con el mouse en el visor 3D (los perfiles y las caras ya
  se eligen así).
- Planos de construcción por otros métodos: a un ángulo, por tres puntos, o
  tangente a una superficie.
- Lienzos sobre planos de construcción y caras (hoy sólo sobre los del origen).
- Extruir "hasta" otra cara o cuerpo, en vez de por distancia.
- Calibrar la escala de un lienzo midiendo sobre la imagen.
