// Generates the Android launcher/splash source assets for @capacitor/assets,
// reusing the SAME art as the desktop app (build/icon.svg). Rasterized with the
// Playwright Chromium already installed in the parent project (no extra dep).
//
// Output (smartfone-remote/resources/): icon-only.png, icon-foreground.png,
// icon-background.png (1024²) and splash.png / splash-dark.png (2732²).
// @capacitor/assets turns these into every mipmap density + the adaptive icon.
//
// Run from the repo root:  node smartfone-remote/scripts/make-icons.mjs
import { chromium } from 'playwright'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const outDir = resolve(here, '..', 'resources')
mkdirSync(outDir, { recursive: true })

// The desktop icon art (rounded square + glow + coral spark).
const iconSvg = readFileSync(resolve(repoRoot, 'build', 'icon.svg'), 'utf8')
// Inner content of icon.svg (drop the outer <svg …> … </svg> wrapper) so we can
// re-embed the art at any size in the splash canvas.
const iconInner = iconSvg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')

const SPARK_DEFS = `
  <linearGradient id="spark" x1="0.15" y1="0.1" x2="0.85" y2="0.95">
    <stop offset="0" stop-color="#ef9272" />
    <stop offset="1" stop-color="#c65e3c" />
  </linearGradient>`

// Adaptive FOREGROUND: just the spark, on transparent, scaled to sit inside the
// adaptive-icon safe zone (the outer ~25% is masked off by the launcher).
const foregroundSvg = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>${SPARK_DEFS}</defs>
  <g transform="translate(256,256) scale(0.78) translate(-256,-256)">
    <path d="M256 86 C 270 196, 316 242, 426 256 C 316 270, 270 316, 256 426 C 242 316, 196 270, 86 256 C 196 242, 242 196, 256 86 Z" fill="url(#spark)" />
    <path d="M390 120 C 395 144, 400 149, 424 154 C 400 159, 395 164, 390 188 C 385 164, 380 159, 356 154 C 380 149, 385 144, 390 120 Z" fill="#f0a484" fill-opacity="0.85" />
  </g>
</svg>`

// Adaptive BACKGROUND: full-bleed dark gradient + coral glow (no rounded corners —
// the launcher applies the mask shape).
const backgroundSvg = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2c2a27" />
      <stop offset="1" stop-color="#1a1918" />
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.44" r="0.62">
      <stop offset="0" stop-color="#d97757" stop-opacity="0.38" />
      <stop offset="1" stop-color="#d97757" stop-opacity="0" />
    </radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)" />
  <rect width="512" height="512" fill="url(#glow)" />
</svg>`

// SPLASH: dark canvas with the full icon centered (~28% of the screen).
const splashSvg = `<svg width="2732" height="2732" viewBox="0 0 2732 2732" xmlns="http://www.w3.org/2000/svg">
  <rect width="2732" height="2732" fill="#1f1e1d" />
  <svg x="982" y="982" width="768" height="768" viewBox="0 0 512 512">${iconInner}</svg>
</svg>`

async function render(svg, size) {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const html =
    `<!doctype html><meta charset="utf-8">` +
    `<style>*{margin:0;padding:0}html,body{width:${size}px;height:${size}px;background:transparent;overflow:hidden}` +
    `svg{width:${size}px;height:${size}px;display:block}</style>` +
    svg
  await page.setContent(html, { waitUntil: 'networkidle' })
  const buf = await page.screenshot({ omitBackground: true, type: 'png' })
  await browser.close()
  return buf
}

const jobs = [
  ['icon-only.png', iconSvg, 1024],
  ['icon-foreground.png', foregroundSvg, 1024],
  ['icon-background.png', backgroundSvg, 1024],
  ['splash.png', splashSvg, 2732],
  ['splash-dark.png', splashSvg, 2732]
]
for (const [name, svg, size] of jobs) {
  writeFileSync(resolve(outDir, name), await render(svg, size))
  console.log('✓', name, `(${size}×${size})`)
}
console.log('Assets do ícone Android gerados em smartfone-remote/resources/')
