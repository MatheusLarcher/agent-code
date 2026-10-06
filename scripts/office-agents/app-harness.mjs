/**
 * Mede o avatar GLB no Escritório 3D numa CÓPIA ISOLADA do app em modo DEV
 * (electron-vite dev com depuração remota): pasta de dados, HOME e banco
 * temporários, sem login do Claude e sem mandar mensagem a agente nenhum. Não
 * toca no app em uso.
 *
 *   node scripts/office-agents/app-harness.mjs [segundos=20] [--shots-only] [--keep] [--novsync]
 *
 * Liga a demonstração (Ctrl+Alt+Shift+D: 20 agentes em 5 salas, o cenário mais
 * cheio) e o HUD (Ctrl+Alt+Shift+P); mede o tempo de quadro (média/P95 do
 * intervalo entre quadros e do trabalho em JS) com o boneco e com a chave de
 * teste ligada (Ctrl+Alt+Shift+V: todos viram o avatar v1 tingido), conta os
 * quadros longos do detector de travadas (logs/travadas.log) e grava capturas:
 * visão geral, alguém sentado digitando, andando e com objeto na mão.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const repo = resolve(import.meta.dirname, '../..')
const secs = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 20)
const shotsOnly = process.argv.includes('--shots-only')
/** Deixa o app aberto no fim (porta impressa) para inspecionar com cdp-eval.mjs. */
const keep = process.argv.includes('--keep')
/** Sem vsync nem teto de quadros: o intervalo mede o custo real (CPU + GPU), não os 60 Hz da tela. */
const novsync = process.argv.includes('--novsync')
/** Só os assentos: espera a demo sentar alguém em cada um (mesa, cochilo, sala de reunião, sofá) e fotografa de frente e de lado. */
const seats = process.argv.includes('--seats')
/** Cada assento com o cérebro congelado: um agente sentado em cada um (mesa, cochilo na mesa, reunião, sofá, cochilo no sofá). */
const posesMode = process.argv.includes('--poses')
const tmp = mkdtempSync(join(tmpdir(), 'agent-code-avatar-'))
const home = join(tmp, 'home')
const shots = join(tmp, 'shots')
mkdirSync(join(home, '.agent-code'), { recursive: true })
mkdirSync(shots, { recursive: true })
writeFileSync(join(home, '.agent-code', 'location.json'), JSON.stringify({ cacheDir: join(tmp, 'cache') }))
const ud = join(tmp, 'ud')
const PORT = 9300 + Math.floor(Math.random() * 500)
const report = { tmp, port: PORT, phases: [] }
const note = (phase, data) => {
  report.phases.push({ phase, ...data })
  console.log(`[${phase}]`, JSON.stringify(data))
}

const child = spawn(process.execPath, [join(repo, 'node_modules/electron-vite/bin/electron-vite.js'), 'dev', '--remoteDebuggingPort', String(PORT), '--', `--user-data-dir=${ud}`, ...(novsync ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])], {
  cwd: repo,
  env: { ...process.env, USERPROFILE: home, HOME: home, AGENT_CODE_HOME: join(tmp, 'agent-home'), ELECTRON_ENABLE_LOGGING: '0' },
  // --keep: destacado e com a saída num arquivo, para sobreviver ao fim deste script.
  detached: keep,
  stdio: keep ? ['ignore', openSync(join(tmp, 'app.log'), 'a'), openSync(join(tmp, 'app.log'), 'a')] : ['ignore', 'pipe', 'pipe']
})
if (keep) child.unref()
let out = ''
child.stdout?.on('data', (d) => (out += d))
child.stderr?.on('data', (d) => (out += d))
const stop = () => {
  if (keep) return
  try {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'])
  } catch {}
}
process.on('exit', stop)

async function connect() {
  for (let i = 0; i < 240; i++) {
    try {
      const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
      for (let k = 0; k < 120; k++) {
        for (const c of b.contexts()) for (const p of c.pages()) if (await p.evaluate(() => !!window.api).catch(() => false)) return { b, page: p }
        await new Promise((r) => setTimeout(r, 500))
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('o app não subiu:\n' + out.slice(-3000))
}

const { b, page } = await connect()
const wait = (ms) => page.waitForTimeout(ms)
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) })
const key = (k) => page.keyboard.press(`Control+Alt+Shift+${k}`)
const userData = await page.evaluate(() => window.api.getAppVersion()).then(() => ud)
if (!existsSync(ud)) throw new Error('userData fora da pasta temporária')
const freezeLog = join(ud, 'logs', 'travadas.log')
const freezes = () => (existsSync(freezeLog) ? readFileSync(freezeLog, 'utf8').split('\n').filter((l) => l.includes('"quadro"')).length : 0)
note('launch', { userData, dev: true, novsync })
page.on('dialog', (d) => d.accept().catch(() => {}))
await page.setViewportSize({ width: 1600, height: 900 }).catch(() => {})

try {
  await wait(3000)
  await page.getByRole('tab', { name: /Escritório/ }).click()
  await page.waitForSelector('[data-testid="office3d-canvas"]')
  await wait(2000)
  await page.getByRole('button', { name: 'Minimizar o chat do Escritório' }).click().catch(() => {})
  await page.mouse.click(800, 450)
  await key('D')
  await key('P')
  await wait(4000)
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
  const chars = () => page.evaluate(() => [...window.__o.scene.chars.values()].length)
  note('demo', { found: await page.evaluate(() => !!window.__o), chars: await chars() })

  // Mede `secs` s com a câmera girando devagar (todo quadro renderiza, nos dois modos igual).
  const measure = async (label) => {
    const before = freezes()
    await page.evaluate(() => {
      const e = window.__o
      e.__spin = setInterval(() => {
        e.rig.orbit(0.6, 0)
        e.requestRender()
      }, 16)
    })
    await wait(2500)
    const samples = []
    for (let i = 0; i < secs; i++) {
      await wait(1000)
      samples.push(await page.evaluate(() => ({ ...window.__o.stats })))
    }
    await page.evaluate(() => clearInterval(window.__o.__spin))
    await wait(1500)
    const avg = (k) => samples.reduce((s, x) => s + x[k], 0) / samples.length
    const max = (k) => Math.max(...samples.map((x) => x[k]))
    const r = {
      fps: +avg('fps').toFixed(1), frameMs: +avg('frameMs').toFixed(2), frameP95: +avg('frameP95').toFixed(2), frameP95max: +max('frameP95').toFixed(2),
      workMs: +avg('workMs').toFixed(2), workP95: +avg('workP95').toFixed(2), workP95max: +max('workP95').toFixed(2),
      calls: Math.round(avg('calls')), triangles: Math.round(avg('triangles')), longFrames: freezes() - before
    }
    note(`medida-${label}`, r)
    return r
  }

  const avatars = () => page.evaluate(() => [...window.__o.scene.chars.values()].filter((c) => !!c.body.avatar).length)
  await page.evaluate(() => window.__o.resetView())
  await wait(2500)
  await shot('01-boneco-geral')
  const base = shotsOnly ? null : await measure('boneco')

  const t0 = Date.now()
  await key('V')
  for (let i = 0; i < 100 && (await avatars()) === 0; i++) await wait(100)
  note('chave-ligada', { avatares: await avatars(), de: await chars(), cargaMs: Date.now() - t0, passos: await page.evaluate(() => window.__o.scene.agents.timings) })
  await wait(1500)
  await page.evaluate(() => window.__o.resetView())
  await wait(2500)
  await shot('02-avatar-geral')
  const av = shotsOnly ? null : await measure('avatar')
  if (base && av) {
    const pct = (a, z) => +(((a - z) / z) * 100).toFixed(1)
    note('comparacao', { frameMs: pct(av.frameMs, base.frameMs), frameP95: pct(av.frameP95, base.frameP95), workMs: pct(av.workMs, base.workMs), workP95: pct(av.workP95, base.workP95) })
  }

  // Close-ups: quem está sentado digitando, quem anda, quem tem objeto na mão, quem gesticula.
  const closeUp = async (name, pick, dist = 2.6, yaw = 0.5, pitch = 0.25, ty = 1.0) => {
    const found = await page.evaluate(
      ({ pick, dist, yaw, pitch, ty }) => {
        const e = window.__o
        const list = [...e.scene.chars.values()].filter((c) => c.group.visible || !c.culled)
        const test = new Function('c', `const b = c.brain; return (${pick})`)
        const c = list.find((x) => test(x))
        if (!c) return null
        // Sem o reenquadramento automático do prédio (o feed da demo chega a cada 1 s).
        e.autoFrame = false
        e.rig.pose = { tx: c.brain.x, ty, tz: c.brain.z, yaw: c.brain.yaw + Math.PI + yaw, pitch, distance: dist }
        e.requestRender()
        return { key: c.key, action: c.brain.action, prop: c.brain.prop, sit: c.brain.sit, speed: c.brain.speed }
      },
      { pick, dist, yaw, pitch, ty }
    )
    await wait(900)
    await shot(name)
    note(name, { found })
  }
  await page.mouse.move(800, 450)
  await page.mouse.wheel(0, -1)
  if (posesMode) {
    // Os lugares vêm dos próprios módulos (servidor do Vite em DEV) e o cérebro para de andar.
    const placed = await page.evaluate(async () => {
      const plan = await import('/src/office3d/officePlan.ts')
      const meet = await import('/src/office3d/meetingRoom.ts')
      const e = window.__o
      e.scene.crowd.step = () => {}
      const list = [...e.scene.chars.values()].filter((c) => c.brain.visible)
      const desk = list.find((c) => c.deskIndex !== null && c.brain.seat === 'chair' && c.brain.sit > 0.9) ?? list[0]
      const rest = list.filter((c) => c !== desk)
      const m = meet.meetingSpots(['tv', 'cadeira'], 0).get('cadeira')
      const L = plan.LOUNGE_SEATS
      const set = (c, p) => Object.assign(c.brain, { speed: 0, sit: 1, reaction: null, pending: [], prop: null, look: 'none', zzz: false, visible: true, actionT: 3, ...p })
      set(desk, { action: 'type' })
      const napper = rest[0]
      set(napper, { x: desk.brain.x, z: desk.brain.z, yaw: desk.brain.yaw, seat: 'chair', action: 'napDesk' })
      // O cochilo na mesa: a mesa do lado (outra baia da mesma ilha).
      const other = list.find((c) => c !== desk && c !== napper && c.deskIndex !== null && c.brain.seat === 'chair' && c.brain.sit > 0.9)
      if (other) set(napper, { x: other.brain.x, z: other.brain.z, yaw: other.brain.yaw }), set(other, { x: 0, z: 9.5, visible: false })
      set(rest[1], { x: m.x, z: m.z, yaw: m.yaw, seat: 'chair', action: 'listen' })
      set(rest[2], { x: L[1].x, z: L[1].z, yaw: L[1].yaw, seat: 'sofa', action: 'phone', prop: 'phone' })
      set(rest[3], { x: L[2].x, z: L[2].z, yaw: L[2].yaw, seat: 'sofa', action: 'napSofa' })
      window.__posed = { mesa: desk.key, cochilo: napper.key, reuniao: rest[1].key, sofa: rest[2].key, cochiloSofa: rest[3].key }
      e.requestRender()
      return window.__posed
    })
    note('poses', placed)
    await wait(2500)
    const shootKey = async (name, key, dist, yaw, pitch, ty) => {
      await page.evaluate(({ key, dist, yaw, pitch, ty }) => {
        const e = window.__o
        const c = e.scene.chars.get(key)
        e.autoFrame = false
        e.rig.pose = { tx: c.brain.x, ty, tz: c.brain.z, yaw: c.brain.yaw + Math.PI + yaw, pitch, distance: dist }
        e.requestRender()
      }, { key, dist, yaw, pitch, ty })
      await wait(1200)
      await shot(name)
    }
    for (const [name, key] of Object.entries(placed)) {
      await shootKey(`p-${name}-frente`, key, 1.9, 0.5, 0.3, 0.75)
      await shootKey(`p-${name}-lado`, key, 1.7, 1.57, 0.25, 0.7)
      await shootKey(`p-${name}-lado2`, key, 1.7, -1.57, 0.25, 0.7)
    }
  }
  if (seats) {
    const SEATS = [
      ['s1-mesa', "c.deskIndex !== null && b.seat === 'chair' && b.sit > 0.97 && b.action !== 'napDesk'", 1.0],
      ['s2-cochilo-mesa', "b.action === 'napDesk' && b.sit > 0.97", 1.0],
      ['s3-reuniao', "c.deskIndex === null && b.seat === 'chair' && b.sit > 0.97", 1.0],
      ['s4-sofa', "b.seat === 'sofa' && b.sit > 0.97 && b.action !== 'napSofa'", 0.8],
      ['s5-cochilo-sofa', "b.action === 'napSofa' && b.sit > 0.97", 0.8]
    ]
    const left = new Set(SEATS.map((x) => x[0]))
    for (let t = 0; t < 240 && left.size; t++) {
      for (const [name, pick, ty] of SEATS) {
        if (!left.has(name)) continue
        const ok = await page.evaluate((pick) => {
          const test = new Function('c', `const b = c.brain; return (${pick})`)
          return [...window.__o.scene.chars.values()].some((c) => !c.culled && c.brain.visible && test(c))
        }, pick)
        if (!ok) continue
        await closeUp(`${name}-a`, pick, 2.3, 0.7, 0.25, ty)
        await closeUp(`${name}-b`, pick, 2.3, 1.57, 0.1, ty)
        left.delete(name)
      }
      await wait(1000)
    }
    note('assentos-faltando', { faltam: [...left] })
    writeFileSync(join(tmp, 'report.json'), JSON.stringify(report, null, 2))
  }
  if (!seats && !posesMode) {
  await closeUp('03-sentado-digitando', "b.sit > 0.95 && (b.action === 'type' || b.action === 'typeFast')", 2.2, 0.6, 0.3, 1.0)
  await closeUp('04-sentado-lado', "b.sit > 0.95 && (b.action === 'type' || b.action === 'typeFast' || b.action === 'readScreen')", 2.4, 1.5, 0.15, 0.9)
  await closeUp('05-objeto-na-mao', "b.prop !== null && b.prop !== undefined", 2.2, 0.4, 0.2, 1.1)
  await closeUp('06-andando', 'b.speed > 0.6', 3.2, 0.9, 0.2, 0.9)
  await closeUp('07-perto-rosto', 'b.visible', 1.2, 0.15, 0.08, 1.55)
  }
  writeFileSync(join(tmp, 'report.json'), JSON.stringify(report, null, 2))
  console.log('capturas:', shots)
} catch (e) {
  console.error('falhou:', e)
  await shot('erro').catch(() => {})
  console.error(out.slice(-2000))
} finally {
  writeFileSync(join(tmp, 'report.json'), JSON.stringify(report, null, 2))
  await b.close().catch(() => {})
  if (keep) console.log(`app aberto: porta ${PORT} (pid ${child.pid})`)
  stop()
  process.exit(0)
}
