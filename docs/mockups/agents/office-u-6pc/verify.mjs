import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const root = import.meta.dirname;
const browser = await chromium.launch({ headless: true });
const errors = [], requests = [];
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, offline: true });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (req) => { if (/^https?:/.test(req.url())) requests.push(req.url()); });
  await page.goto(pathToFileURL(join(root, 'index.html')).href);
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  const inspect = () => page.evaluate(() => {
    const { scene, camera, renderer, stations } = window.officeMockup;
    scene.updateMatrixWorld(true);
    const screens = [];
    scene.traverse((object) => {
      if (object.name !== 'monitor-screen') return;
      const position = object.position.clone(); object.getWorldPosition(position);
      const projected = position.clone().project(camera);
      const normal = object.position.clone().set(0, 0, 1).transformDirection(object.matrixWorld);
      const direction = camera.position.clone().sub(position).normalize();
      screens.push({ inFrame: Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1, facingCamera: normal.dot(direction) > .4 });
    });
    return { stationCount: stations.length, screens, width: renderer.domElement.width, height: renderer.domElement.height };
  });
  const desktop = await inspect();
  if (desktop.stationCount !== 6 || desktop.screens.length !== 6 || desktop.screens.some((s) => !s.inFrame || !s.facingCamera)) throw new Error('Six visible, forward-facing screens required');
  await page.screenshot({ path: join(root, 'preview.png') });
  await page.mouse.move(800, 500); await page.mouse.down(); await page.mouse.move(1010, 520, { steps: 4 }); await page.mouse.up();
  const rotated = await page.evaluate(() => Math.abs(window.officeMockup.camera.position.x) > .1);
  if (!rotated) throw new Error('Camera drag did not rotate the view');
  await page.mouse.dblclick(800, 500);
  const reset = await page.evaluate(() => Math.abs(window.officeMockup.camera.position.x) < .001 && window.officeMockup.camera.zoom === 1);
  if (!reset) throw new Error('Camera reset failed');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => window.officeMockup.renderer.domElement.width === 390);
  const mobile = await inspect();
  if (mobile.screens.some((s) => !s.inFrame)) throw new Error('Mobile view crops a monitor');
  await page.screenshot({ path: join(root, 'preview-mobile.png') });
  if (errors.length || requests.length) throw new Error(JSON.stringify({ errors, requests }));
  const report = { desktop, mobile, offline: true, externalRequests: requests.length, browserErrors: errors, cameraDrag: rotated, cameraReset: reset };
  writeFileSync(join(root, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
