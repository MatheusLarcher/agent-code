/**
 * Confere o avatar GLB no APP EMPACOTADO (dist/win-unpacked, electron-builder
 * --dir): a janela abre por file://, o modelo vem por IPC de
 * resources/office-agents e as texturas sem URL blob: (a CSP do app as
 * recusaria). Cópia isolada via Playwright: --user-data-dir e HOME próprios
 * numa pasta temporária, sem login do Claude e sem mandar mensagem a ninguém.
 *
 *   npm run build && npx electron-builder --dir && node scripts/office-agents/packaged-check.mjs [exe]
 *
 * Sem atalho de DEV no build de produção: a chave de teste é ligada pelo motor
 * (window.__o.scene.agents.setPreview). Popula o escritório com conversas pelo
 * mesmo IPC do App, liga a chave, confere quantos agentes viraram avatar, a
 * textura no material, os passos da carga e os quadros longos (travadas.log).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'

const repo = resolve(import.meta.dirname, '../..')
const exe = process.argv[2] ?? join(repo, 'dist', 'win-unpacked', 'Agent Code.exe')
if (!existsSync(exe)) throw new Error(`não achei o app empacotado: ${exe}`)
const tmp = mkdtempSync(join(tmpdir(), 'agent-code-pkg-'))
const home = join(tmp, 'home')
const shots = join(tmp, 'shots')
mkdirSync(join(home, '.agent-code'), { recursive: true })
mkdirSync(shots, { recursive: true })
writeFileSync(join(home, '.agent-code', 'location.json'), JSON.stringify({ cacheDir: join(tmp, 'cache') }))
const ud = join(tmp, 'ud')
const report = { tmp, exe, phases: [] }
const note = (phase, data) => {
  report.phases.push({ phase, ...data })
  console.log(`[${phase}]`, JSON.stringify(data))
}

async function launch() {
  const app = await electron.launch({
    executablePath: exe,
    args: [`--user-data-dir=${ud}`],
    env: { ...process.env, USERPROFILE: home, HOME: home, AGENT_CODE_HOME: join(tmp, 'agent-home'), ELECTRON_ENABLE_LOGGING: '0' },
    timeout: 120_000
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(30_000)
  page.on('dialog', (d) => d.accept().catch(() => {}))
  await page.waitForFunction(() => !!window.api, null, { timeout: 60_000 })
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
  if (!userData.startsWith(tmp)) {
    await app.close()
    throw new Error('userData fora da pasta temporária: abortando para não tocar o app em uso')
  }
  return { app, page, userData }
}

// 1ª subida: as conversas (uma por agente principal, em 3 projetos) e fecha.
{
  const { app, page, userData } = await launch()
  const t = Date.now()
  const projs = ['loja', 'portal', 'erp'].map((n) => join(tmp, n))
  for (const p of projs) mkdirSync(p, { recursive: true })
  const convs = Array.from({ length: 12 }, (_, i) => ({
    id: `pkg-conv-${i}`, title: `Conversa ${i}`, cwd: projs[i % 3], model: 'claude-opus-4-5', sdkSessionId: null, messages: [],
    tokens: { context: 0, output: 0, cost: 0 }, createdAt: t - i * 1000, updatedAt: t - i * 1000
  }))
  await page.evaluate((list) => window.api.saveAllConversations(list), convs)
  await page.waitForTimeout(1500)
  note('launch', { userData, url: page.url().slice(0, 40), packaged: await app.evaluate(({ app: a }) => a.isPackaged) })
  await app.close()
}

const { app, page } = await launch()
const freezeLog = join(ud, 'logs', 'travadas.log')
const freezes = () => (existsSync(freezeLog) ? readFileSync(freezeLog, 'utf8').split('\n').filter((l) => l.includes('"quadro"')) : [])
try {
  const ipc = await page.evaluate(async () => {
    const glb = await window.api.officeAgentFile('principal.glb')
    const env = await window.api.officeAgentFile('ambiente.bin')
    const bad = await window.api.officeAgentFile('../package.json')
    return { glbBytes: glb?.byteLength ?? 0, envBytes: env?.byteLength ?? 0, recusa: bad === null }
  })
  note('ipc', ipc)
  await page.waitForTimeout(2000)
  await page.getByRole('tab', { name: /Escritório/ }).click()
  await page.waitForSelector('[data-testid="office3d-canvas"]')
  await page.waitForTimeout(3000)
  await page.getByRole('button', { name: 'Minimizar o chat do Escritório' }).click().catch(() => {})
  await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="office3d-canvas"]')
    const k = Object.keys(canvas).find((x) => x.startsWith('__reactFiber$'))
    for (let f = canvas[k]; f; f = f.return) {
      for (let h = f.memoizedState; h && typeof h === 'object' && 'next' in h; h = h.next) {
        const v = h.memoizedState
        if (v && typeof v === 'object' && v.current && v.current.rig && v.current.board) window.__o = v.current
      }
      if (window.__o) break
    }
  })
  await page.screenshot({ path: join(shots, '01-boneco.png') })
  const before = freezes().length
  const t0 = Date.now()
  await page.evaluate(() => window.__o.scene.agents.setPreview(true))
  const count = () => page.evaluate(() => [...window.__o.scene.chars.values()].filter((c) => !!c.body.avatar).length)
  for (let i = 0; i < 100 && (await count()) === 0; i++) await page.waitForTimeout(100)
  await page.waitForTimeout(2500)
  const state = await page.evaluate(() => {
    const list = [...window.__o.scene.chars.values()]
    const a = list.find((c) => c.body.avatar)?.body.avatar
    const m = a?.material
    return {
      agentes: list.length,
      avatares: list.filter((c) => !!c.body.avatar).length,
      textura: m?.map?.image ? [m.map.image.width, m.map.image.height] : null,
      ambiente: m?.envMap?.image ? [m.envMap.image.width, m.envMap.image.height] : null,
      passos: window.__o.scene.agents.timings
    }
  })
  note('chave-ligada', { ...state, ms: Date.now() - t0 })
  await page.evaluate(() => window.__o.resetView())
  await page.waitForTimeout(2500)
  await page.screenshot({ path: join(shots, '02-avatar.png') })
  // Sai e volta para a aba (o motor pausa e retoma) com o avatar ligado.
  await page.getByRole('tab', { name: /Conversa/ }).click()
  await page.waitForTimeout(1500)
  await page.getByRole('tab', { name: /Escritório/ }).click()
  await page.waitForTimeout(3000)
  await page.screenshot({ path: join(shots, '03-volta.png') })
  // O log de travadas grava em lote (até 5 s): espera antes de contar.
  await page.waitForTimeout(6000)
  const novos = freezes().slice(before).map((l) => {
    const j = JSON.parse(l)
    return { ms: j.ms, tab: j.ctx?.tab, scripts: (j.scripts ?? []).map((s) => `${s.sourceFunctionName ?? s.invoker}:${s.ms}`) }
  })
  note('quadros-longos-depois-da-chave', { n: novos.length, novos })
} catch (e) {
  console.error('falhou:', e)
  await page.screenshot({ path: join(shots, 'erro.png') }).catch(() => {})
} finally {
  writeFileSync(join(tmp, 'report.json'), JSON.stringify(report, null, 2))
  console.log('capturas:', shots)
  await app.close().catch(() => {})
}
