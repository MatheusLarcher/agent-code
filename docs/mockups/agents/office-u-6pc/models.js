import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { screenTexture } from './screens.js';

export const material = (color, roughness = .75, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, ...extra });
export const M = {
  wood: material('#c79b68'), edge: material('#b58b60'), white: material('#dedbd3'),
  dark: material('#292d32'), metal: material('#3d4247', .45, { metalness: .45 }),
  chair: material('#343737'), leaf: material('#527546'), leafDark: material('#304f34'),
  ceramic: material('#d7caba', .5), soil: material('#42392e'), shoe: material('#ede8dd'),
};
export function mesh(parent, geometry, mat, x = 0, y = 0, z = 0, scale) {
  const object = new THREE.Mesh(geometry, mat); object.position.set(x, y, z);
  if (scale) object.scale.set(...scale);
  object.castShadow = true; object.receiveShadow = true; parent.add(object); return object;
}
export function box(parent, mat, w, h, d, x, y, z, radius = .025) {
  return mesh(parent, new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, w / 3, h / 3, d / 3)), mat, x, y, z);
}
export function sphere(parent, mat, x, y, z, sx, sy = sx, sz = sx) {
  return mesh(parent, new THREE.SphereGeometry(1, 20, 14), mat, x, y, z, [sx, sy, sz]);
}
export function cylinder(parent, mat, top, bottom, height, x, y, z) {
  return mesh(parent, new THREE.CylinderGeometry(top, bottom, height, 24), mat, x, y, z);
}
function limb(parent, mat, a, b, radius) {
  const av = new THREE.Vector3(...a), bv = new THREE.Vector3(...b);
  const result = mesh(parent, new THREE.CapsuleGeometry(radius, Math.max(.01, av.distanceTo(bv) - 2 * radius), 5, 12), mat);
  result.position.copy(av).add(bv).multiplyScalar(.5);
  result.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), bv.sub(av).normalize());
  return result;
}
export function plant(parent, x, y, z, scale = 1) {
  const group = new THREE.Group(); group.position.set(x, y, z); group.scale.setScalar(scale); parent.add(group);
  cylinder(group, M.ceramic, .15, .115, .27, 0, .135, 0);
  cylinder(group, M.soil, .134, .134, .012, 0, .276, 0);
  for (let i = 0; i < 9; i++) {
    const angle = i * 2.4, height = .47 + (i % 3) * .09;
    const leaf = sphere(group, i % 2 ? M.leaf : M.leafDark, Math.sin(angle) * .13, height, Math.cos(angle) * .13, .065, .23, .027);
    leaf.rotation.set(Math.cos(angle) * .43, angle, Math.sin(angle) * .43);
    limb(group, M.leafDark, [0, .26, 0], [Math.sin(angle) * .14, height, Math.cos(angle) * .14], .009);
  }
  return group;
}
function mug(parent, x, y, z, color) {
  const mat = material(color, .36);
  cylinder(parent, mat, .085, .072, .16, x, y + .08, z);
  cylinder(parent, material('#423526'), .067, .067, .006, x, y + .164, z);
  const handle = mesh(parent, new THREE.TorusGeometry(.056, .016, 10, 20), mat, x + .083, y + .085, z);
  handle.rotation.y = Math.PI / 2;
}
function chair(parent, x, z) {
  const group = new THREE.Group(); group.position.set(x, 0, z); parent.add(group);
  box(group, M.chair, .64, .13, .62, 0, .51, 0, .06);
  const back = box(group, M.chair, .63, .62, .12, 0, .86, .29, .06); back.rotation.x = -.12;
  box(group, M.metal, .1, .38, .06, 0, .68, .37);
  cylinder(group, M.metal, .035, .045, .4, 0, .27, 0);
  for (let i = 0; i < 5; i++) {
    const a = i * Math.PI * 2 / 5;
    const foot = box(group, M.metal, .06, .045, .37, Math.sin(a) * .17, .105, Math.cos(a) * .17);
    foot.rotation.y = a;
    sphere(group, M.dark, Math.sin(a) * .35, .063, Math.cos(a) * .35, .056, .052, .045);
  }
  for (const s of [-1, 1]) {
    box(group, M.metal, .04, .2, .04, s * .34, .65, .05);
    box(group, M.chair, .085, .055, .34, s * .34, .76, -.02);
  }
  return group;
}
function agent(parent, x, z, config) {
  const group = new THREE.Group(); group.position.set(x, 0, z); parent.add(group);
  const skin = material(config.skin, .85), shirt = material(config.shirt), hair = material(config.hair), pants = material('#3c454f');
  sphere(group, pants, 0, .60, -.02, .23, .13, .2);
  sphere(group, shirt, 0, .87, .035, .265, .29, .18);
  for (const s of [-1, 1]) {
    limb(group, pants, [s * .125, .59, -.01], [s * .15, .56, -.40], .095);
    limb(group, pants, [s * .15, .54, -.40], [s * .15, .13, -.39], .073);
    box(group, M.shoe, .18, .11, .31, s * .15, .1, -.45, .05);
    limb(group, shirt, [s * .23, 1.01, .01], [s * .34, .78, -.17], .086);
    limb(group, shirt, [s * .34, .78, -.17], [s * .22, .87, -.45], .07);
    sphere(group, skin, s * .22, .87, -.46, .07, .035, .08);
    for (let i = 0; i < 4; i++) box(group, skin, .018, .02, .068, s * .22 + (i - 1.5) * .023, .874, -.5, .006);
  }
  cylinder(group, skin, .065, .076, .14, 0, 1.16, .035);
  const head = new THREE.Group(); head.position.set(0, 1.35, .03);
  head.rotation.y = config.turn; group.add(head);
  sphere(head, skin, 0, 0, 0, .20, .235, .185);
  sphere(head, skin, -.203, -.012, 0, .042, .063, .035);
  sphere(head, skin, .203, -.012, 0, .042, .063, .035);
  sphere(head, skin, 0, -.025, -.18, .045, .045, .055);
  const white = material('#faf4e8'), iris = material('#40392e');
  for (const s of [-1, 1]) {
    sphere(head, white, s * .076, .032, -.163, .047, .04, .014);
    sphere(head, iris, s * .074, .029, -.177, .02, .025, .009);
    sphere(head, white, s * .074 - .006, .039, -.184, .005);
    const brow = box(head, hair, .075, .019, .018, s * .077, .092, -.165, .008); brow.rotation.z = s * -.10;
  }
  const smile = mesh(head, new THREE.TorusGeometry(.046, .007, 6, 16, Math.PI), material('#9f604f'), 0, -.055, -.169);
  smile.rotation.z = Math.PI;
  sphere(head, hair, 0, .145, .035, .209, .13, .185);
  for (let i = 0; i < 11; i++) {
    const a = i * 2.4;
    sphere(head, hair, Math.sin(a) * .14, .16 + (i % 3) * .03, Math.cos(a) * .12, .067, .066, .073);
  }
  if (config.long) {
    sphere(head, hair, -.18, -.02, .085, .065, .23, .08);
    sphere(head, hair, .18, -.02, .085, .065, .23, .08);
  }
  if (config.glasses) {
    for (const s of [-1, 1]) {
      const rim = mesh(head, new THREE.TorusGeometry(.054, .007, 8, 24), M.dark, s * .077, .032, -.188); rim.scale.y = .82;
    }
    box(head, M.dark, .047, .012, .01, 0, .035, -.191, .004);
  }
  return group;
}
export function workstation(parent, station, config) {
  const group = new THREE.Group(); group.position.set(station.x, 0, station.z); group.rotation.y = station.yaw;
  group.name = `station-${station.id}`; parent.add(group);
  box(group, M.wood, 2.10, .085, 1.24, 0, .84, 0, .035);
  for (const x of [-.95, .95]) {
    box(group, M.edge, .07, .76, .96, x, .42, 0);
    box(group, M.dark, .11, .03, 1.05, x, .032, 0);
  }
  box(group, M.white, .045, .44, 1.19, -1.04, 1.02, -.015);
  box(group, M.white, .045, .44, 1.19, 1.04, 1.02, -.015);
  box(group, M.white, 2.12, .44, .045, 0, 1.02, -.63);
  box(group, M.ceramic, .44, .57, .62, .67, .37, -.15);
  for (let i = 0; i < 3; i++) {
    box(group, M.edge, .42, .16, .03, .67, .17 + i * .18, .175);
    box(group, M.metal, .13, .012, .025, .67, .19 + i * .18, .196, .005);
  }
  const pc = box(group, M.dark, .19, .4, .4, -.68, .24, -.13);
  pc.name = 'pc';
  sphere(group, material('#89c7b2', .5, { emissive: '#67a191', emissiveIntensity: .3 }), -.68, .34, .077, .008);
  box(group, M.dark, .68, .026, .22, -.07, .902, .33, .014);
  for (let r = 0; r < 4; r++) for (let k = 0; k < 13; k++) box(group, M.metal, .039, .009, .035, -.36 + k * .046, .919, .25 + r * .045, .003);
  sphere(group, M.dark, .43, .909, .33, .046, .024, .069);
  const monitor = new THREE.Group(); monitor.position.set(-.14, 0, -.26); group.add(monitor);
  box(monitor, M.dark, .38, .028, .23, 0, .897, 0, .015);
  box(monitor, M.metal, .075, .26, .055, 0, 1.02, -.055);
  const display = new THREE.Group(); display.position.set(0, 1.47, -.055); display.rotation.x = -.09; monitor.add(display);
  box(display, M.dark, 1.43, .87, .065, 0, 0, 0, .025);
  const screen = mesh(display, new THREE.PlaneGeometry(1.35, .785), new THREE.MeshBasicMaterial({ map: screenTexture(station.id), toneMapped: false }), 0, .013, .034);
  screen.name = 'monitor-screen'; screen.castShadow = false; screen.receiveShadow = false;
  plant(group, -.86, .89, -.33, .5);
  mug(group, .74, .887, .31, config.mug);
  box(group, material('#314555'), .19, .018, .31, -.74, .9, .30, .012);
  const seatX = station.id === 0 || station.id === 2 || station.id === 4 ? .39 : .28;
  chair(group, seatX, .92); agent(group, seatX, .89, config);
  return group;
}
