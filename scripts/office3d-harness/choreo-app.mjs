/**
 * Validação da COREOGRAFIA do quadro (quem mudou vai ao quadro e fala o
 * motivo) numa CÓPIA ISOLADA do app — o build em out/, via Playwright, com
 * `--user-data-dir` e HOME/USERPROFILE próprios numa pasta temporária, banco
 * próprio, sem login do Claude e sem mandar mensagem a agente nenhum.
 *
 *   npm run build && node scripts/office3d-harness/choreo-app.mjs
 *
 * As mudanças "do agente" (ingestão do plano: sem evento), "do PO" e "do
 * sistema" (com evento) são gravadas direto no banco isolado; as do usuário
 * vão pelo mesmo IPC do Quadro (boardMove/boardDismiss). Cada fase grava uma
 * captura em <tmp>/shots e o resumo em JSON no fim.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright'

const repo = resolve(import.meta.dirname, '../..')
const electronPath = createRequire(import.meta.url)('electron')
const tmp = mkdtempSync(join(tmpdir(), 'agent-code-choreo-'))
const home = join(tmp, 'home')
const shots = join(tmp, 'shots')
mkdirSync(join(home, '.agent-code'), { recursive: true })
mkdirSync(shots, { recursive: true })
writeFileSync(join(home, '.agent-code', 'location.json'), JSON.stringify({ cacheDir: join(tmp, 'cache') }))
const proj = join(tmp, 'coreografia')
mkdirSync(proj)
const report = { tmp, phases: [] }
const note = (phase, data) => {
  report.phases.push({ phase, ...data })
  console.log(`[${phase}]`, JSON.stringify(data))
}

function projectIdOf(cwd) {
  const sha = (s) => createHash('sha256').update(s).digest('hex')
  const hex = sha(`agent-code-project:${sha(`manual-folder:${basename(resolve(cwd)).toLocaleLowerCase('en-US')}`)}`)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

const CONV = 'iso-conv-1'
const OLD = 'iso-conv-velha'
const N = 18

function seed(dbPath) {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA busy_timeout = 8000')
  const pid = projectIdOf(proj)
  const now = Date.now()
  const ins = db.prepare(`INSERT INTO board_items(id, project_id, project_cwd, conversation_id, origin, source_id, source_title, source_status, active_form, seq,
    po_title, po_note, po_status, po_reason, po_at, dismissed_at, revision, created_at, updated_at) VALUES(?,?,?,?,'agent',?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,1,?,?)`)
  const ev = db.prepare('INSERT INTO board_item_events(id, board_item_id, at, kind, actor, from_status, to_status, note) VALUES(?,?,?,?,?,?,?,?)')
  for (let i = 0; i < N; i++) {
    const at = new Date(now - (i + 1) * 60_000).toISOString()
    const id = `c${i}`
    const conv = i === 17 ? OLD : CONV
    ins.run(id, pid, proj, conv, id, `Tarefa ${i} do plano`, i === 1 ? 'in_progress' : 'pending', i === 1 ? 'Fazendo a tarefa 1' : null, i, at, at)
    ev.run(`${id}-e0`, id, at, 'created', 'agent', null, 'pending', null)
  }
  db.close()
  return pid
}

/** Grava como o main grava: o agente sem evento; PO e sistema com evento. */
function write(dbPath, list) {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA busy_timeout = 8000')
  const at = new Date().toISOString()
  let n = 0
  for (const w of list) {
    if (w.kind === 'agent-status') {
      db.prepare('UPDATE board_items SET source_status=?, active_form=?, po_status=NULL, po_reason=NULL, revision=revision+1, updated_at=? WHERE id=?').run(w.status, w.activeForm ?? null, at, w.id)
    } else if (w.kind === 'agent-new') {
      const pid = projectIdOf(proj)
      db.prepare(`INSERT INTO board_items(id, project_id, project_cwd, conversation_id, origin, source_id, source_title, source_status, active_form, seq,
        po_title, po_note, po_status, po_reason, po_at, dismissed_at, revision, created_at, updated_at) VALUES(?,?,?,?,'agent',?,?,'pending',NULL,99,NULL,NULL,NULL,NULL,NULL,NULL,1,?,?)`).run(w.id, pid, proj, CONV, w.id, w.title, at, at)
    } else if (w.kind === 'agent-gone') {
      db.prepare('DELETE FROM board_item_events WHERE board_item_id=?').run(w.id)
      db.prepare('DELETE FROM board_items WHERE id=?').run(w.id)
    } else {
      // po | system: muda o status efetivo e grava o evento com o motivo.
      db.prepare('UPDATE board_items SET po_status=?, po_reason=?, po_at=?, revision=revision+1, updated_at=? WHERE id=?').run(w.status, w.note, at, at, w.id)
      db.prepare('INSERT INTO board_item_events(id, board_item_id, at, kind, actor, from_status, to_status, note) VALUES(?,?,?,?,?,?,?,?)').run(`${w.id}-x${Date.now()}-${n++}`, w.id, at, 'status_changed', w.kind, null, w.status, w.note)
    }
  }
  db.close()
}

process.on('uncaughtException', (e) => console.error('[ignorado]', String(e?.message ?? e)))

async function launch() {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [repo, `--user-data-dir=${join(tmp, 'ud')}`],
    cwd: repo,
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

{
  const { app, page, userData } = await launch()
  const t = Date.now()
  const conv = (id, title, cwd, ago = 0) => ({ id, title, cwd, model: 'claude-opus-4-5', sdkSessionId: null, messages: [], tokens: { context: 0, output: 0, cost: 0 }, createdAt: t - ago, updatedAt: t - ago })
  // A conversa velha (13 h parada) fica fora do escritório; o recorte é o projeto inteiro.
  await page.evaluate((list) => window.api.saveAllConversations(list), [conv(CONV, 'Conversa da coreografia', proj), conv(OLD, 'Conversa parada', proj, 13 * 3600_000)])
  await page.waitForTimeout(1500)
  await app.close()
  note('launch', { userData, isolated: true })
  report.db = join(userData, 'agent-code-local', 'agent-code.db')
}
note('seed', { projectId: seed(report.db) })

let { app, page } = await launch()
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) })
const wait = (ms) => page.waitForTimeout(ms)

async function openOffice() {
  await page.getByRole('tab', { name: /Escritório/ }).click()
  await page.waitForSelector('[data-testid="office3d-canvas"]')
  await wait(2500)
  await page.getByRole('button', { name: 'Minimizar o chat do Escritório' }).click().catch(() => {})
  await page.evaluate(() => {
    window.__o = null
    const canvas = document.querySelector('[data-testid="office3d-canvas"]')
    const key = Object.keys(canvas).find((k) => k.startsWith('__reactFiber$'))
    for (let f = canvas[key]; f; f = f.return) {
      for (let h = f.memoizedState; h && typeof h === 'object' && 'next' in h; h = h.next) {
        const v = h.memoizedState
        if (v && typeof v === 'object' && v.current && v.current.rig && v.current.board) window.__o = v.current
      }
      if (window.__o) break
    }
  })
}

const room = () => page.evaluate(() => window.__o.board.sync.roomIds.find((id) => id.endsWith('coreografia')))
const camTo = async (distance = 7.5) => {
  await page.mouse.move(700, 430)
  await page.mouse.wheel(0, -1)
  await page.evaluate((distance) => {
    const e = window.__o
    const r = e.scene.rooms3d.find((x) => x.id.endsWith('coreografia'))
    e.rig.pose = { tx: r.x + 2.2, ty: 0.9, tz: r.z + 2.2, yaw: 0, pitch: 0.35, distance }
    e.requestRender()
  }, distance)
  await wait(600)
}
const refresh = async () => page.evaluate(() => window.__o.board.sync.refresh(window.__o.board.sync.roomIds.find((id) => id.endsWith('coreografia'))))
/** Retrato do que importa: parede × real, quem está no quadro, balões e selos. */
const probe = () =>
  page.evaluate(() => {
    const e = window.__o
    const rid = e.board.sync.roomIds.find((id) => id.endsWith('coreografia'))
    const m = e.board.sync.mirror(rid)
    const brain = (k) => {
      const b = e.scene.crowd.brains.get(k)
      return b ? { mode: b.mode, sit: +b.sit.toFixed(2), action: b.action, prop: b.prop, errand: b.errand ? `${b.errand.state}#${b.errand.idx}/${b.errand.stops.length}` : null, x: +b.x.toFixed(2), z: +b.z.toFixed(2) } : null
    }
    return {
      pending: m.pending,
      quips: [...document.querySelectorAll('.qb[data-kind="board"]')].map((q) => q.textContent),
      seals: [...document.querySelectorAll('.o3d-board-seal')].map((q) => q.textContent),
      agent: brain('conv:iso-conv-1'),
      po: brain(`po:${rid}`),
      waiting: e.board.stage.choreo.waiting,
      trips: e.board.stage.choreo.active.map((t) => ({ key: t.key, steps: t.steps.length, gait: t.errand.gait, summary: t.summary }))
    }
  })
/** Acompanha até a parede bater com o real e ninguém estar no quadro; devolve o tempo e tudo o que foi visto. */
async function follow(label, maxMs = 25_000) {
  const t0 = Date.now()
  const seen = { quips: new Set(), seals: new Set(), actions: new Set(), agentErrand: false, poErrand: false, maxPending: 0, trips: [] }
  let p
  let shotTaken = false
  for (;;) {
    p = await probe()
    p.quips.forEach((q) => seen.quips.add(q))
    p.seals.forEach((q) => seen.seals.add(q))
    if (p.agent?.errand) { seen.agentErrand = true; seen.actions.add(`agent:${p.agent.action}`) }
    if (p.po?.errand) { seen.poErrand = true; seen.actions.add(`po:${p.po.action}`) }
    if (p.trips.length) seen.trips.push(...p.trips.filter((t) => !seen.trips.some((x) => x.key === t.key && x.steps === t.steps)))
    seen.maxPending = Math.max(seen.maxPending, p.pending)
    if (!shotTaken && (p.quips.length || p.seals.length)) {
      shotTaken = true
      await shot(`${label}-durante`)
    }
    const idle = !p.agent?.errand && !p.po?.errand && p.waiting === 0 && p.trips.length === 0
    if ((p.pending === 0 && idle && Date.now() - t0 > 600) || Date.now() - t0 > maxMs) break
    await wait(200)
  }
  const ms = Date.now() - t0
  const out = { ms, ...seen, quips: [...seen.quips], seals: [...seen.seals], actions: [...seen.actions], end: p }
  note(label, out)
  return out
}

try {
  await page.getByText('Conversa da coreografia').first().click().catch(() => {})
  await wait(800)
  await openOffice()
  await camTo()
  note('velha-fora-do-escritorio', { brain: await page.evaluate(() => !!window.__o.scene.crowd.brains.get('conv:iso-conv-velha')) })
  // Agente trabalhando (fase forçada no cérebro: sem login não há sessão rodando): senta, vai ao quadro e volta a sentar.
  await page.evaluate(() => { const b = window.__o.scene.crowd.brains.get('conv:iso-conv-1'); window.__work = setInterval(() => { b.phase = 'working'; b.tool = 'edit' }, 50) })
  await wait(6000)
  const seated0 = await probe()
  write(report.db, [{ kind: 'agent-status', id: 'c9', status: 'in_progress' }])
  await refresh()
  const worked = await follow('00-agente-em-work')
  await wait(9000)
  note('volta-a-sentar', { antes: seated0.agent, foiAoQuadro: worked.agentErrand, depois: (await probe()).agent })
  await page.evaluate(() => clearInterval(window.__work))
  note('abrir', { found: await page.evaluate(() => !!window.__o), probe: await probe() })
  await shot('01-sala')

  // 1) O agente conclui a 0 e começa a 2 no mesmo retrato: UMA ida, fala "Concluí"/"Comecei", volta.
  write(report.db, [{ kind: 'agent-status', id: 'c0', status: 'completed' }, { kind: 'agent-status', id: 'c2', status: 'in_progress', activeForm: 'Escrevendo a tarefa 2' }])
  await refresh()
  await wait(300)
  // Clique no balão do quadro abre o cartão grande.
  let bubbleOpened = null
  for (let i = 0; i < 60 && bubbleOpened === null; i++) {
    const q = page.locator('.qb[data-kind="board"]').first()
    if (await q.count()) {
      await q.click({ force: true }).catch(() => {})
      await wait(400)
      bubbleOpened = (await page.locator('[data-testid="o3d-board-overlay"]').count()) > 0
      await shot('02b-clique-no-balao')
      await page.keyboard.press('Escape')
    } else await wait(200)
  }
  const agentTrip = await follow('02-agente-ida-agrupada')
  note('clique-balao', { opened: bubbleOpened })

  // 2) Fim de turno (sistema): o PO leva e diz que é regra.
  write(report.db, [{ kind: 'system', id: 'c2', status: 'pending', note: 'o turno terminou sem concluir esta tarefa' }])
  await refresh()
  await follow('03-fim-de-turno')

  // 3) Correção do PO: o balão traz o motivo real.
  write(report.db, [{ kind: 'po', id: 'c3', status: 'completed', note: 'conferi no app rodando: o quadro bate' }])
  await refresh()
  await follow('04-correcao-do-po')

  // 4) Usuário pelo Quadro do app: desliza com "Você"; clique no selo abre o cartão.
  await page.evaluate(() => window.api.boardMove('c4', 'completed'))
  await refresh()
  await wait(500)
  const sealOpen = page.locator('.o3d-board-seal').first()
  let sealOpened = null
  if (await sealOpen.count()) {
    await shot('05-selo-voce')
    await sealOpen.click({ force: true })
    await wait(400)
    sealOpened = (await page.locator('[data-testid="o3d-board-overlay"]').count()) > 0
    await page.keyboard.press('Escape')
  }
  const user = await follow('05-usuario-pelo-app')
  note('clique-selo', { opened: sealOpened })

  // 5) Novo, retirado do plano e conversa fora do escritório.
  write(report.db, [{ kind: 'agent-new', id: 'c-novo', title: 'Tarefa nova do agente' }])
  await refresh()
  await follow('06-novo')
  write(report.db, [{ kind: 'agent-gone', id: 'c5' }])
  await refresh()
  await follow('07-tirou-do-plano')
  await page.evaluate(() => window.api.boardDismiss('c6', true))
  await refresh()
  await follow('08-dispensado-pelo-usuario')
  await page.evaluate(() => window.api.boardDismiss('c6', false))
  await refresh()
  await follow('09-restaurado')
  write(report.db, [{ kind: 'agent-status', id: 'c17', status: 'completed' }])
  await refresh()
  await follow('10-conversa-fora-do-escritorio')

  // 6) FPS durante uma ida (quadros por segundo medidos no próprio renderer).
  write(report.db, [{ kind: 'agent-status', id: 'c7', status: 'in_progress' }])
  await refresh()
  const fps = await page.evaluate(
    () =>
      new Promise((res) => {
        let n = 0
        const t0 = performance.now()
        const f = () => {
          n++
          if (performance.now() - t0 < 3000) requestAnimationFrame(f)
          else res(Math.round((n * 1000) / (performance.now() - t0)))
        }
        requestAnimationFrame(f)
      })
  )
  note('fps-durante-ida', { fps })
  await follow('11-ida-para-fps')

  // 7) 10 mudanças de uma vez: converge em ~15 s com fala-resumo.
  write(report.db, Array.from({ length: 10 }, (_, i) => ({ kind: 'agent-status', id: `c${i + 7}`, status: 'completed' })))
  await refresh()
  const burst = await follow('12-dez-de-uma-vez', 30_000)
  note('dez-resumo', { converged: burst.end.pending === 0, ms: burst.ms, summary: burst.trips.map((t) => t.summary).filter(Boolean) })

  // 8) Arrasto no 3D: não reanima (sem ida, sem selo).
  // (o arrasto real com o mouse já está validado em isolated-app.mjs; aqui a confirmação do main volta com o papel já no lugar)
  const dragRoom = await room()
  const dragged = await page.evaluate(async (rid) => {
    const e = window.__o
    const r = await e.board.sync.move(rid, 'c-novo', 'completed')
    return r
  }, dragRoom)
  await refresh()
  await follow('13-arrasto-no-3d')
  note('arrasto-3d', { result: dragged })

  // 9) Sair da aba no meio de uma ida e voltar: direto, sem maratona.
  write(report.db, [{ kind: 'agent-status', id: 'c15', status: 'pending' }, { kind: 'agent-status', id: 'c14', status: 'in_progress' }])
  await refresh()
  await wait(1200)
  const mid = await probe()
  await page.getByRole('tab', { name: /Conversa/ }).first().click().catch(() => {})
  await wait(800)
  await page.getByRole('tab', { name: /Escritório/ }).click().catch(() => {})
  await wait(2000)
  note('sair-e-voltar', { meio: mid.agent?.errand, depois: await probe() })

  // 10) F5.
  await page.reload()
  await page.waitForFunction(() => !!window.api)
  await wait(2500)
  await openOffice()
  await camTo()
  note('f5', { probe: await probe() })
  await shot('14-depois-do-f5')

  // 11) PO desligado: a regra do sistema desliza com o selo em terceira pessoa.
  const cfg = await page.evaluate(() => window.api.getConfig())
  await page.evaluate((board) => window.api.setConfig({ board }), { ...(cfg.board ?? {}), po: { ...(cfg.board?.po ?? {}), enabled: false } })
  await page.reload()
  await page.waitForFunction(() => !!window.api)
  await wait(2500)
  await openOffice()
  await camTo()
  write(report.db, [{ kind: 'system', id: 'c14', status: 'pending', note: 'o turno terminou sem concluir esta tarefa' }])
  await refresh()
  await follow('15-po-desligado')
  await shot('15-po-desligado')
  note('resumo-agente', { umaIda: agentTrip.trips.length === 1 && agentTrip.trips[0].steps === 2, user })
} catch (e) {
  note('erro', { message: String(e?.stack ?? e) })
  await shot('99-erro').catch(() => {})
} finally {
  await app.close().catch(() => {})
  writeFileSync(join(tmp, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\nRELATÓRIO: ${join(tmp, 'report.json')}\nCAPTURAS: ${shots}`)
}
