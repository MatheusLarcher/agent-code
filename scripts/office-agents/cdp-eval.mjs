/**
 * Avalia JS na janela do app aberto pelo app-harness.mjs --keep (CDP) e,
 * opcional, grava uma captura. O motor 3D fica em window.__o.
 *
 *   node scripts/office-agents/cdp-eval.mjs <porta> "<expressão>" [captura.png]
 */
import { chromium } from 'playwright'

const [port, expr, png] = process.argv.slice(2)
const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
let page = null
for (const c of b.contexts()) for (const p of c.pages()) if (!page && (await p.evaluate(() => !!window.api).catch(() => false))) page = p
const r = await page.evaluate(`(async () => (${expr}))()`)
console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 1))
if (png) await page.screenshot({ path: png })
await b.close()
