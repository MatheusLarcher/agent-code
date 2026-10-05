import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { M, material, mesh, box, sphere, cylinder, plant, workstation } from './models.js';

const host = document.getElementById('office');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02; host.appendChild(renderer.domElement);
renderer.domElement.setAttribute('aria-label', 'Escritório 3D em U com seis agentes e seis telas voltadas para você');
renderer.domElement.setAttribute('role', 'img');
const scene = new THREE.Scene(); scene.background = new THREE.Color('#b9b1a7');
const camera = new THREE.OrthographicCamera(-8, 8, 4.5, -4.5, .1, 80);
const home = new THREE.Vector3(0, 9.4, 13.5), target = new THREE.Vector3(0, 1.12, -.4);
camera.position.copy(home); camera.lookAt(target);
const controls = new OrbitControls(camera, renderer.domElement); controls.target.copy(target);
controls.enablePan = false; controls.enableDamping = false;
controls.minAzimuthAngle = -.26; controls.maxAzimuthAngle = .26;
controls.minPolarAngle = .58; controls.maxPolarAngle = .98;
controls.minZoom = .8; controls.maxZoom = 1.8;
const render = () => renderer.render(scene, camera);
controls.addEventListener('change', render);
function reset() { camera.position.copy(home); camera.zoom = 1; controls.target.copy(target); camera.updateProjectionMatrix(); controls.update(); render(); }
renderer.domElement.addEventListener('dblclick', reset);
window.addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 'r') reset(); });
scene.add(new THREE.HemisphereLight('#fff4df', '#948678', 1.65));
const sun = new THREE.DirectionalLight('#fff0d5', 2.45); sun.position.set(-4, 8, 5); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -8; sun.shadow.camera.right = 8;
sun.shadow.camera.top = 8; sun.shadow.camera.bottom = -8; sun.shadow.camera.far = 25;
sun.shadow.normalBias = .025; sun.shadow.bias = -.00015; sun.shadow.radius = 4; scene.add(sun);
const fill = new THREE.DirectionalLight('#d4e5ee', .7); fill.position.set(5, 4, 2); scene.add(fill);

function texture(color, grainColor, seed, floor = false) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
  const c = canvas.getContext('2d'); c.fillStyle = color; c.fillRect(0, 0, 512, 512);
  let value = seed; const random = () => { value = (value * 1664525 + 1013904223) >>> 0; return value / 4294967296; };
  c.strokeStyle = grainColor;
  for (let i = 0; i < (floor ? 6500 : 430); i++) {
    c.globalAlpha = random() * .16; const x = random() * 512, y = random() * 512;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + (floor ? random() * 2 : 90 + random() * 300), y + random() * 2); c.stroke();
  }
  const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(floor ? 5 : 1, floor ? 5 : 1); return t;
}
M.wood.color.set('#ffffff'); M.wood.map = texture('#c5a47f', '#795537', 15);
const room = new THREE.Group(); scene.add(room);
const floorMat = material('#ffffff', .95, { map: texture('#bdb4a7', '#72695f', 81, true) });
box(room, floorMat, 11.2, .12, 10.0, 0, -.075, -.1, .02);
const wall = material('#dbd5ca', .92), trim = material('#c9c0b2');
box(room, wall, 11.2, 2.85, .12, 0, 1.40, -5.05, .01);
box(room, trim, 11.1, .10, .09, 0, .05, -4.95, .008);
for (const side of [-1, 1]) {
  box(room, wall, .12, 2.85, 6.2, side * 5.55, 1.40, -1.99, .01);
  box(room, trim, .09, .10, 6.1, side * 5.46, .05, -1.99, .008);
}
const stations = [
  { id: 0, x: -1.13, z: -3.05, yaw: 0 }, { id: 1, x: 1.13, z: -3.05, yaw: 0 },
  { id: 2, x: -3.58, z: -.65, yaw: .28 }, { id: 3, x: 3.58, z: -.65, yaw: -.28 },
  { id: 4, x: -3.75, z: 1.95, yaw: .34 }, { id: 5, x: 3.75, z: 1.95, yaw: -.34 },
];
const agents = [
  { shirt: '#557952', skin: '#e8b68c', hair: '#53382a', turn: -2.85, mug: '#577f88' },
  { shirt: '#e5dbc6', skin: '#e9b69e', hair: '#35282b', turn: 2.85, long: true, mug: '#617e8b' },
  { shirt: '#414144', skin: '#d49d85', hair: '#69436e', turn: -2.85, long: true, mug: '#58767d' },
  { shirt: '#4a78a0', skin: '#e5ad81', hair: '#ae6133', turn: 2.85, glasses: true, mug: '#7a8a79' },
  { shirt: '#4e78a0', skin: '#edc19c', hair: '#b78043', turn: -2.85, mug: '#779283' },
  { shirt: '#876198', skin: '#d6a285', hair: '#443030', turn: 2.85, long: true, mug: '#668484' },
];
stations.forEach((station, i) => workstation(room, station, agents[i]));

// Mobília decorativa fica junto às paredes, deixando o interior do U livre.
plant(room, -4.75, 0, -3.92, 1.8); plant(room, -3.63, 0, -4.33, 1.35);
plant(room, 4.75, 0, 3.55, 1.18); plant(room, -4.85, 0, 3.62, 1.15);
const cabinet = new THREE.Group(); cabinet.position.set(4.53, 0, -3.85); room.add(cabinet);
box(cabinet, M.wood, 1.38, 1.18, .6, 0, .64, 0);
box(cabinet, M.edge, 1.28, .48, .035, 0, .38, .319);
box(cabinet, M.dark, 1.22, .47, .015, 0, .91, .308);
for (let i = 0; i < 9; i++) {
  const book = box(cabinet, material(['#647c88', '#b59065', '#846a66', '#d8c6a7'][i % 4]), .075, .30 + (i % 3) * .04, .22, -.51 + i * .11, .90, .31, .005);
  book.rotation.z = i > 6 ? -.12 : 0;
}
plant(cabinet, -.46, 1.25, 0, .66);
const lightMat = material('#ffdf9a', .25, { emissive: '#ffc96e', emissiveIntensity: 1.25 });
sphere(cabinet, lightMat, .38, 1.44, .03, .19);
cylinder(room, M.ceramic, .17, .17, .58, -4.73, .3, -2.6);
cylinder(room, lightMat, .173, .173, .45, -4.73, .55, -2.6);
const frameMat = material('#716453');
for (const x of [-2.85, 2.9]) {
  box(room, frameMat, .93, .74, .055, x, 1.98, -4.955);
  box(room, material('#e8dfce'), .82, .63, .018, x, 1.98, -4.92);
  sphere(room, material(x < 0 ? '#8c9b91' : '#b49e7f'), x, 1.94, -4.89, .27, .16, .012);
}
box(room, M.wood, 2.7, .065, .22, 0, 2.36, -4.89);
plant(room, -.97, 2.395, -4.86, .4); plant(room, .85, 2.395, -4.86, .45);
box(room, M.ceramic, .34, .44, .12, -.08, 2.62, -4.86);

function resize() {
  const { width, height } = host.getBoundingClientRect();
  if (width <= 0 || height <= 0) return;
  const aspect = width / height, h = Math.max(8.8, 12.4 / aspect);
  camera.left = -h * aspect / 2; camera.right = h * aspect / 2;
  camera.top = h / 2; camera.bottom = -h / 2;
  camera.updateProjectionMatrix(); renderer.setSize(width, height, false); render();
}
new ResizeObserver(resize).observe(host); controls.update(); resize();
window.officeMockup = { scene, camera, renderer, controls, reset, stations };
document.documentElement.dataset.ready = 'true';
