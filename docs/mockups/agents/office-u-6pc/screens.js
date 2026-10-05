import * as THREE from 'three';

const colors = ['#98c379', '#61afef', '#c678dd', '#e5c07b', '#abb2bf', '#e06c75'];
export function screenTexture(kind) {
  const canvas = document.createElement('canvas');
  canvas.width = 960; canvas.height = 600;
  const c = canvas.getContext('2d');
  const rect = (color, x, y, w, h) => { c.fillStyle = color; c.fillRect(x, y, w, h); };
  const text = (label, x, y, color = '#abb6c7', size = 17) => {
    c.fillStyle = color; c.font = `${size}px Consolas, monospace`; c.fillText(label, x, y);
  };
  rect('#111826', 0, 0, 960, 600); rect('#1e2939', 0, 0, 960, 38);
  ['#fa7870', '#f4c764', '#7bc695'].forEach((color, i) => {
    c.fillStyle = color; c.beginPath(); c.arc(21 + i * 21, 20, 5, 0, Math.PI * 2); c.fill();
  });
  text(['workspace.ts', 'preview / app', 'terminal', 'dashboard', 'components.tsx', 'tasks / agent'][kind], 112, 25, '#cbd5e1', 15);
  if (kind === 1) {
    rect('#edf0f3', 45, 67, 870, 478); rect('#ffffff', 45, 67, 870, 55);
    text('larcher / workspace', 75, 100, '#334155', 19);
    rect('#31465c', 75, 145, 810, 181);
    text('Build something great.', 110, 209, '#f8fafc', 34);
    text('Your projects, together.', 112, 244, '#b9ccd9', 20);
    rect('#e19862', 110, 270, 170, 32);
    for (let i = 0; i < 3; i++) {
      rect('#ffffff', 75 + i * 279, 350, 252, 157);
      rect(['#a5bdc1', '#bdb29e', '#8099a8'][i], 91 + i * 279, 366, 220, 75);
      rect('#c9d1d8', 91 + i * 279, 459, 147, 9);
      rect('#e1e5e9', 91 + i * 279, 480, 191, 7);
    }
  } else if (kind === 3) {
    for (let i = 0; i < 3; i++) {
      rect('#1e2b3e', 38 + i * 307, 69, 273, 101);
      text(['Requests', 'Success', 'Active agents'][i], 61 + i * 307, 101, '#9aaac1', 17);
      text(['2,486', '99.8%', '6'][i], 61 + i * 307, 146, '#e3eaf3', 34);
    }
    rect('#192537', 38, 198, 884, 209);
    for (let i = 0; i < 5; i++) rect('#29384e', 70, 231 + i * 34, 819, 1);
    c.strokeStyle = '#b18af3'; c.lineWidth = 5; c.beginPath();
    [308, 295, 322, 261, 281, 239, 268, 218, 245, 213, 228, 205].forEach((y, i) => {
      if (!i) c.moveTo(78, y); else c.lineTo(78 + i * 73, y);
    }); c.stroke();
    for (let i = 0; i < 17; i++) rect(colors[i % 3], 67 + i * 50, 525 - (i * 29 % 97), 27, 30 + (i * 29 % 97));
  } else {
    const terminal = kind === 2;
    if (!terminal) { rect('#172130', 0, 38, 172, 534); text('EXPLORER', 19, 70, '#7f90a5', 15); }
    const lines = terminal ? [
      '$ npm run typecheck', 'Checking workspace...', 'node / web / phone  ✓', '', '$ npm test',
      '✓ agent session', '✓ office layout', '✓ renderer', '', 'Test Files   42 passed',
      'Tests       284 passed', '', '$ npm run build', 'Building desktop...', '✓ renderer compiled', '✓ build completed'
    ] : [
      'import { Agent } from "./agent";', '', 'export const workspace = {', '  name: "agent-code",',
      '  layout: "u-shaped",', '  agents: 6,', '};', '', 'async function runTask(input) {',
      '  const agent = new Agent(input);', '  await agent.plan();', '', '  return agent.execute({',
      '    context: workspace,', '    status: "ready",', '  });', '}'
    ];
    if (!terminal) ['src', '  main', '  renderer', '    office', '    agents', '  shared', 'tests', 'package.json'].forEach((s, i) => text(s, 18, 114 + i * 28, '#91a2b8', 14));
    lines.forEach((line, i) => {
      if (!terminal) text(String(i + 1).padStart(2), 191, 85 + i * 25, '#526177', 14);
      text(line, terminal ? 32 : 232, 85 + i * 25, terminal ? '#92d6b0' : colors[i % colors.length], 18);
    });
  }
  rect('#273a4e', 0, 570, 960, 30); text('main   ✓ ready', 18, 591, '#b8cfda', 14);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}
