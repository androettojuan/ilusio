// Prueba del solver de restricciones: un rectángulo "a mano alzada"
// debe convertirse en un rectángulo exacto de 80 x 50.
import { make_gcs_wrapper } from '@salusoft89/planegcs';
import { SolveStatus } from '@salusoft89/planegcs';

const gcs = await make_gcs_wrapper();

// Cuatro esquinas dibujadas torcidas a propósito
const pts = [
  { id: 'p1', type: 'point', x: 0,    y: 0,   fixed: true  },
  { id: 'p2', type: 'point', x: 73.4, y: 4.1, fixed: false },
  { id: 'p3', type: 'point', x: 78.9, y: 46,  fixed: false },
  { id: 'p4', type: 'point', x: -2.3, y: 51,  fixed: false },
];
const lines = [
  { id: 'l1', type: 'line', p1_id: 'p1', p2_id: 'p2' },
  { id: 'l2', type: 'line', p1_id: 'p2', p2_id: 'p3' },
  { id: 'l3', type: 'line', p1_id: 'p3', p2_id: 'p4' },
  { id: 'l4', type: 'line', p1_id: 'p4', p2_id: 'p1' },
];
const constraints = [
  { id: 'c1', type: 'horizontal_l', l_id: 'l1' },
  { id: 'c2', type: 'vertical_l',   l_id: 'l2' },
  { id: 'c3', type: 'horizontal_l', l_id: 'l3' },
  { id: 'c4', type: 'vertical_l',   l_id: 'l4' },
  { id: 'c5', type: 'p2p_distance', p1_id: 'p1', p2_id: 'p2', distance: 80 },
  { id: 'c6', type: 'p2p_distance', p1_id: 'p2', p2_id: 'p3', distance: 50 },
];

gcs.push_primitives_and_params([...pts, ...lines, ...constraints]);
const status = gcs.solve();
console.log('estado del solver:', SolveStatus[status] ?? status);
gcs.apply_solution();

for (const p of pts) {
  const r = gcs.sketch_index.get_sketch_point(p.id);
  console.log(`  ${p.id}: (${r.x.toFixed(4)}, ${r.y.toFixed(4)})`);
}
console.log('conflictivas:', gcs.get_gcs_conflicting_constraints());
console.log('redundantes:', gcs.get_gcs_redundant_constraints());
