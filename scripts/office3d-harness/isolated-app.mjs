/**
 * Validação do kanban do Escritório 3D numa CÓPIA ISOLADA do app (o build em
 * out/, via Playwright): `--user-data-dir` e HOME/USERPROFILE próprios numa
 * pasta temporária (o ponteiro ~/.agent-code/location.json aponta a pasta de
 * dados para lá), banco próprio, sem login do Claude e sem mandar mensagem a
 * agente nenhum. Não toca no app em uso nem no banco dele.
 *
 *   npm run build && node scripts/office3d-harness/isolated-app.mjs
 *
 * Projetos: "kanban-demo" (24 cartões do Quadro, com PO, aguardando e eventos),
 * "quadro-vazio" (sem cartões) e "pasta-sumida" (pasta que não existe: o
 * quadro fica indisponível). Cada fase grava uma captura em <tmp>/shots e o
 * resumo em JSON no fim. O motor do 3D é achado pela árvore do React.
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
const tmp = mkdtempSync(join(tmpdir(), 'agent-code-o3d-'))
const home = join(tmp, 'home')
const shots = join(tmp, 'shots')
mkdirSync(join(home, '.agent-code'), { recursive: true })
mkdirSync(shots, { recursive: true })
writeFileSync(join(home, '.agent-code', 'location.json'), JSON.stringify({ cacheDir: join(tmp, 'cache') }))
const proj = join(tmp, 'kanban-demo')
const empty = join(tmp, 'quadro-vazio')
const missing = join(tmp, 'pasta-sumida')
mkdirSync(proj)
mkdirSync(empty)
const report = { tmp, phases: [] }
const note = (phase, data) => {
  report.phases.push({ phase, ...data })
  console.log(`[${phase}]`, JSON.stringify(data))
}

/** O mesmo id que o main calcula para uma pasta sem git (persistence/projectIdentity.ts). */
function projectIdOf(cwd) {
  const sha = (s) => createHash('sha256').update(s).digest('hex')
  const hex = sha(`agent-code-project:${sha(`manual-folder:${basename(resolve(cwd)).toLocaleLowerCase('en-US')}`)}`)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

const TITLES = [
  'Mapear como o quadro chega ao 3D', 'Desenhar o kanban na parede do fundo', 'Ler o quadro em vez de prender papel',
  'Abrir o cartão grande ao clicar', 'Arrastar o papel para mudar de coluna', 'Pilha +K na coluna cheia', 'Bilhete de quadro vazio',
  'Plaquinha de quadro indisponível', 'Dica com o nome da conversa', 'Mensagem de recusa perto do quadro', 'Sem replay ao abrir a aba',
  'Deslize suave até a coluna nova', 'Atraso máximo de 15 s', 'LOD: texto só de perto', 'Textura redesenhada só na mudança',
  'Alfinete na cor do agente', 'Marca do PO no papel', 'Clipe de aguardando você', 'Carimbo de concluído', 'Bloquinho e cesto ao lado',
  'Lugar diante de cada coluna', 'Janelas mais perto do telão', 'Esc cancela o arrasto', 'Câmera gira fora do papel'
]

function seed(dbPath, convId) {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA busy_timeout = 8000')
  const pid = projectIdOf(proj)
  const now = Date.now()
  const ins = db.prepare(`INSERT INTO board_items(id, project_id, project_cwd, conversation_id, origin, source_id, source_title, source_status, active_form, seq,
    po_title, po_note, po_status, po_reason, po_at, dismissed_at, revision, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,NULL,?,NULL,NULL,?,?,?,NULL,1,?,?)`)
  const ev = db.prepare('INSERT INTO board_item_events(id, board_item_id, at, kind, actor, from_status, to_status, note) VALUES(?,?,?,?,?,?,?,?)')
  TITLES.forEach((title, i) => {
    const status = i < 11 ? 'pending' : i < 15 ? 'in_progress' : 'completed'
    const at = new Date(now - (i + 1) * 60_000).toISOString()
    const po = i === 2
    const awaiting = i === 4
    const id = `iso-${i}`
    ins.run(id, pid, proj, convId, po ? 'po' : 'agent', po ? null : String(i), title, awaiting ? 'in_progress' : status, i,
      awaiting ? 'pending' : null, awaiting ? 'o turno terminou sem concluir esta tarefa' : po ? 'o agente não testou o quadro vazio' : null, awaiting || po ? at : null, at, at)
    ev.run(`${id}-e0`, id, at, 'created', po ? 'po' : 'agent', null, status, po ? 'o agente não testou o quadro vazio' : null)
  })
  db.close()
  return pid
}

process.on('uncaughtException', (e) => console.error('[ignorado]', String(e?.message ?? e)))

/** Sobe a cópia isolada (o mesmo userData e HOME temporários em cada subida). */
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
  // O app confirma antes de recarregar (beforeunload): aceita, sem deixar o Playwright tropeçar.
  page.on('dialog', (d) => {
    report.dialogs = (report.dialogs ?? 0) + 1
    d.accept().catch(() => {})
  })
  await page.waitForFunction(() => !!window.api, null, { timeout: 60_000 })
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
  if (!userData.startsWith(tmp)) {
    await app.close()
    throw new Error('userData fora da pasta temporária: abortando para não tocar o app em uso')
  }
  return { app, page, userData }
}

// 1ª subida: as conversas pelo mesmo IPC do App; fecha (o app regrava o banco enquanto roda).
{
  const { app, page, userData } = await launch()
  const t = Date.now()
  const conv = (id, title, cwd) => ({ id, title, cwd, model: 'claude-opus-4-5', sdkSessionId: null, messages: [], tokens: { context: 0, output: 0, cost: 0 }, createdAt: t, updatedAt: t })
  await page.evaluate((list) => window.api.saveAllConversations(list), [conv('iso-conv-1', 'Conversa do kanban', proj), conv('iso-conv-2', 'Conversa sem cartões', empty), conv('iso-conv-3', 'Conversa de pasta sumida', missing)])
  await page.waitForTimeout(1500)
  await app.close()
  note('launch', { userData, isolated: true })
  report.db = join(userData, 'agent-code-local', 'agent-code.db')
}
// Com o app fechado: os cartões direto no banco isolado.
note('seed', { projectId: seed(report.db, 'iso-conv-1') })

const { app, page } = await launch()
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) })
const wait = (ms) => page.waitForTimeout(ms)
try {
  const listed = await page.evaluate((cwd) => window.api.boardList({ projectCwd: cwd }), proj)
  note('boardList-real', { available: listed.available, items: listed.items.length })
  await wait(2000)
  await page.getByRole('tab', { name: /Escritório/ }).click()
  await page.waitForSelector('[data-testid="office3d-canvas"]')
  await wait(2500)
  // O chat flutuante (Central) fica por cima do meio do palco: minimiza.
  await page.getByRole('button', { name: 'Minimizar o chat do Escritório' }).click().catch(() => {})
  await wait(400)
  // O motor, pela árvore do React (build de produção: sem atalho de DEV).
  await page.evaluate(() => {
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
  const state = () =>
    page.evaluate(() => {
      const e = window.__o
      return e.board.sync.roomIds.map((id) => {
        const m = e.board.sync.mirror(id)
        return { id, available: m.available, shown: m.shown.length, cols: [0, 1, 2].map((c) => m.shown.filter((x) => x.status === ['pending', 'in_progress', 'completed'][c]).length) }
      })
    })
  note('abrir-aba', { found: await page.evaluate(() => !!window.__o), rooms: await state(), steps: await page.evaluate(() => window.__o.board.sync.steps.size) })
  await shot('01-visao-geral')

  // Câmera diante do kanban de cada sala (um gesto do usuário antes: a câmera para de se reenquadrar sozinha).
  const camTo = async (roomCwd, distance = 6.2) => {
    await page.mouse.move(700, 430)
    await page.mouse.wheel(0, -1)
    await page.evaluate(
      ({ cwd, distance }) => {
        const e = window.__o
        const r = e.scene.rooms3d.find((x) => x.id === cwd.replace(/[\\/]+/g, '/').toLowerCase())
        e.rig.pose = { tx: r.x + 1.625, ty: 0.95, tz: r.z + 0.3, yaw: 0, pitch: 0.12, distance }
        e.requestRender()
      },
      { cwd: roomCwd, distance }
    )
    await wait(700)
  }
  const paperAt = (id) =>
    page.evaluate((cardId) => {
      const e = window.__o
      const room = e.scene.boards.roomOfCard(cardId)
      if (!room) return null
      const v = new e.camera.position.constructor()
      if (!e.scene.boards.view(room).paperWorld(cardId, v)) return null
      v.y -= 0.085
      v.project(e.camera)
      const r = document.querySelector('[data-testid="office3d-canvas"]').getBoundingClientRect()
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }
    }, id)
  const slotAt = (cwd, col, row) =>
    page.evaluate(
      ({ cwd, col, row }) => {
        const e = window.__o
        const r = e.scene.rooms3d.find((x) => x.id === cwd.replace(/[\\/]+/g, '/').toLowerCase())
        const v = new e.camera.position.constructor(r.x + 1.625 - 1.275 + 0.85 * (col + 0.5), 0.96 + 0.305 - 0.18 * row, r.z + 0.12)
        v.project(e.camera)
        const c = document.querySelector('[data-testid="office3d-canvas"]').getBoundingClientRect()
        return { x: c.left + ((v.x + 1) / 2) * c.width, y: c.top + ((1 - v.y) / 2) * c.height }
      },
      { cwd, col, row }
    )
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10)
  }
  const wall = (id) => page.evaluate((cardId) => window.__o.board.sync.mirror(window.__o.scene.boards.roomOfCard(cardId))?.card(cardId)?.status ?? null, id)
  /** O status efetivo no Quadro real (o mesmo boardList da aba Quadro). */
  const real = (id) =>
    page.evaluate(({ cwd, cardId }) => window.api.boardList({ projectCwd: cwd }).then((b) => {
      const it = b.items.find((i) => i.id === cardId)
      return it ? (it.poStatus ?? it.sourceStatus) : null
    }), { cwd: proj, cardId: id })

  await camTo(proj)
  await shot('02-quadro-cheio-pilhas')

  // Hover: o papel sobe e brilha; dica com o nome da conversa; cursor de mão.
  const p0 = await paperAt('iso-0')
  await page.mouse.move(p0.x, p0.y)
  await wait(300)
  note('hover', { tip: await page.locator('.o3d-board-tip').textContent(), tipVisible: await page.locator('.o3d-board-tip').isVisible(), cursor: await page.evaluate(() => document.querySelector('[data-testid="office3d-canvas"]').style.cursor) })
  await shot('03-hover')

  // Clique curto: o cartão grande com a linha do tempo; Esc fecha.
  await page.mouse.click(p0.x, p0.y)
  await page.waitForSelector('[data-testid="o3d-board-overlay"]')
  await wait(500)
  note('cartao-grande', { title: await page.locator('[data-testid="o3d-board-overlay"] h3').textContent(), timeline: await page.locator('.board-timeline-row').count() })
  await shot('04-cartao-grande')
  await page.keyboard.press('Escape')
  await wait(200)
  note('esc', { closed: (await page.locator('[data-testid="o3d-board-overlay"]').count()) === 0 })

  // Mudança pelo Quadro do app (o mesmo IPC do arrasto do painel): o papel desliza no 3D.
  await page.evaluate(() => window.api.boardMove('iso-1', 'completed'))
  await wait(250)
  await shot('05-deslizando')
  await wait(1500)
  note('mudanca-pelo-app', { wall: await wall('iso-1'), real: await real('iso-1'), steps: await page.evaluate(() => window.__o.board.sync.steps.size) })
  await shot('06-deslizou')

  // Arrasto no 3D: sucesso (A fazer → Concluído).
  const p3 = await paperAt('iso-3')
  await drag(p3, await slotAt(proj, 2, 1))
  await shot('07-arrastando')
  note('arrastando', { cursor: await page.evaluate(() => document.querySelector('[data-testid="office3d-canvas"]').style.cursor), dragging: await page.evaluate(() => window.__o.scene.boards.view(window.__o.scene.boards.roomOfCard('iso-3')).dragging) })
  await page.mouse.up()
  await wait(2500)
  note('arrasto-sucesso', { wall: await wall('iso-3'), real: await real('iso-3'), busy: await page.evaluate(() => window.__o.scene.boards.view(window.__o.scene.boards.roomOfCard('iso-3')).busy('iso-3')) })
  await shot('08-arrasto-sucesso')

  // Recusa: para "Fazendo" sem sessão viva — volta e mostra a mensagem do main.
  const p5 = await paperAt('iso-5')
  await drag(p5, await slotAt(proj, 1, 2))
  await page.mouse.up()
  await wait(600)
  note('recusa', { status: await wall('iso-5'), toast: await page.locator('.o3d-board-toast').textContent(), toastVisible: await page.locator('.o3d-board-toast').isVisible() })
  await shot('09-recusa')

  // Esc no meio do arrasto e soltar fora do quadro: volta (papéis que estão na parede, parados).
  await wait(1200)
  const onWall = (status) =>
    page.evaluate((st) => {
      const e = window.__o
      const room = e.board.sync.roomIds.find((id) => id.endsWith('kanban-demo'))
      const v = e.scene.boards.view(room)
      return e.board.sync.mirror(room).shown.filter((c) => c.status === st && v.has(c.id) && !v.busy(c.id)).map((c) => c.id)
    }, status)
  const [a, b] = await onWall('pending')
  await drag(await paperAt(a), await slotAt(proj, 2, 2))
  const escDragging = await page.evaluate((id) => window.__o.scene.boards.view(window.__o.scene.boards.roomOfCard(id)).dragging, a)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await wait(1200)
  const pb = await paperAt(b)
  await drag(pb, { x: pb.x, y: pb.y + 360 })
  await page.mouse.up()
  await wait(1200)
  note('esc-e-fora', { escDragging, esc: { id: a, wall: await wall(a), real: await real(a) }, fora: { id: b, wall: await wall(b), real: await real(b) } })

  // Fora do papel o botão esquerdo gira a câmera.
  const yaw0 = await page.evaluate(() => window.__o.rig.pose.yaw)
  const box = await page.locator('[data-testid="office3d-canvas"]').boundingBox()
  await page.mouse.move(box.x + 60, box.y + 80)
  await page.mouse.down()
  await page.mouse.move(box.x + 170, box.y + 80, { steps: 6 })
  await page.mouse.up()
  note('camera', { yaw0, yaw1: await page.evaluate(() => window.__o.rig.pose.yaw) })
  await camTo(proj)

  // Pilha "+K": a lista da coluna.
  const pile = await slotAt(proj, 0, 4)
  await page.mouse.click(pile.x, pile.y)
  await wait(600)
  note('pilha', { dialog: await page.locator('[data-testid="o3d-board-overlay"]').getAttribute('aria-label').catch(() => null), rows: await page.locator('.o3d-board-rows li').count() })
  await shot('10-pilha-lista')
  await page.keyboard.press('Escape')

  // Quadro vazio e indisponível.
  await camTo(empty)
  await shot('11-quadro-vazio')
  await camTo(missing)
  await shot('12-quadro-indisponivel')
  note('vazio-indisponivel', { rooms: await state() })

  // Sair da aba e voltar; F5.
  await page.getByRole('tab', { name: /Conversa/ }).first().click().catch(() => {})
  await wait(400)
  await page.evaluate(() => window.api.boardMove('iso-8', 'completed'))
  await wait(800)
  await page.getByRole('tab', { name: /Escritório/ }).click().catch(() => {})
  await wait(1500)
  note('voltar-aba', { status: await wall('iso-8'), busy: await page.evaluate(() => window.__o.scene.boards.view(window.__o.scene.boards.roomOfCard('iso-8')).busy('iso-8')), steps: await page.evaluate(() => window.__o.board.sync.steps.size) })
  await page.reload()
  await page.waitForFunction(() => !!window.api)
  await wait(2500)
  await page.getByRole('tab', { name: /Escritório/ }).click().catch(() => {})
  await wait(2500)
  note('f5', { canvas: (await page.locator('[data-testid="office3d-canvas"]').count()) > 0 })
  await shot('13-depois-do-f5')
} catch (e) {
  note('erro', { message: String(e?.stack ?? e) })
  await shot('99-erro').catch(() => {})
} finally {
  await app.close().catch(() => {})
  writeFileSync(join(tmp, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`\nRELATÓRIO: ${join(tmp, 'report.json')}\nCAPTURAS: ${shots}`)
}
