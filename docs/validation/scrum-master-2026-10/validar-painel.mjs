// Validação do Scrum Master no Escritório 3D e do painel dele, numa instância ISOLADA em DEV
// (electron-vite dev + depuração remota): pasta de dados própria em %TEMP% (AGENT_CODE_DEV_DATA_DIR),
// diário e conversa do SM em arquivos da rodada (AGENT_CODE_SCRUM_LOG_FILE / _CHAT_FILE).
// Nunca toca o app instalado nem o banco do usuário. O diário semeado é o da validação real
// (diario.jsonl desta pasta), com o projeto trocado por uma pasta da rodada e 3 cobranças de ontem.
//
//  1. Demo de 5 salas (Ctrl+Alt+Shift+D): o SM na sala (camisa na cor do projeto), a visita à mesa,
//     e o tempo de quadro (HUD, câmera girando) por SECS segundos.
//  2. Clique real no SM → painel; Histórico com o corte; Questionar → o SM responde (modelo real);
//     "Marcar como corte errado" → a marca de contestado; fechar e reabrir; F5; erro de leitura do
//     diário e a volta; reiniciar o app e conferir que a marca persiste.
//
// Uso: node docs/validation/scrum-master-2026-10/validar-painel.mjs [segundos=20]
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { APP_ROOT, isolatedEnv, shutdown, waitForMemory } from '../../../scripts/replay/instance.mjs'

const OUT = path.join(APP_ROOT, 'docs', 'validation', 'scrum-master-2026-10')
const SECS = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 20)
const BASE = path.join(os.tmpdir(), `sm-painel-${Date.now()}`)
const DATA = path.join(BASE, 'data')
const PROJ = path.join(BASE, 'smproj')
const LOGF = path.join(BASE, 'scrum-decisions.log')
const CHATF = path.join(BASE, 'scrum-chat.jsonl')
const LOG = path.join(OUT, 'painel-execucao.log')
const t0 = Date.now()
const log = (line) => {
  const l = `[${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s] ${line}`
  console.log(l)
  appendFileSync(LOG, `${l}\n`)
}
const result = { checks: {}, medidas: {}, notas: [] }
const check = (name, ok, extra) => {
  result.checks[name] = ok
  log(`${ok ? 'OK  ' : 'FALHOU'} ${name}${extra ? ` — ${extra}` : ''}`)
}

function seed() {
  mkdirSync(PROJ, { recursive: true })
  const rows = readFileSync(path.join(OUT, 'diario.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const today = rows.map((r) => ({ ...r, projectCwd: PROJ }))
  // Ontem: as cobranças de novo, um dia antes (o dia fechado com o resumo).
  const yesterday = today.filter((r) => r.tipo === 'cobrou').map((r) => ({ ...r, id: `${r.id}-ontem`, at: new Date(Date.parse(r.at) - 86_400_000).toISOString() }))
  writeFileSync(LOGF, [...yesterday, ...today].map((r) => JSON.stringify(r)).join('\n') + '\n')
  log(`diário semeado: ${today.length} de hoje + ${yesterday.length} de ontem em ${LOGF}`)
}

// ---------- instância ----------

async function launchDev(label) {
  await waitForMemory(4, { log })
  const port = 9300 + Math.floor(Math.random() * 500)
  const env = { ...isolatedEnv(DATA), AGENT_CODE_SCRUM_LOG_FILE: LOGF, AGENT_CODE_SCRUM_CHAT_FILE: CHATF, ELECTRON_ENABLE_LOGGING: '0' }
  for (const k of ['APPDATA', 'LOCALAPPDATA', 'TEMP']) mkdirSync(env[k], { recursive: true })
  const out = openSync(path.join(BASE, `app-${label}.log`), 'a')
  // Janela coberta por outra não pode frear o rAF (a demo e a medida do quadro dependem dele).
  const noThrottle = ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling']
  const child = spawn(process.execPath, [path.join(APP_ROOT, 'node_modules/electron-vite/bin/electron-vite.js'), 'dev', '--remoteDebuggingPort', String(port), '--', ...noThrottle], { cwd: APP_ROOT, env, stdio: ['ignore', out, out] })
  for (let i = 0; i < 360; i++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      for (let k = 0; k < 240; k++) {
        for (const c of browser.contexts()) for (const p of c.pages()) if (await p.evaluate(() => !!window.api).catch(() => false)) {
          log(`[${label}] app no ar (porta ${port}, pid ${child.pid})`)
          p.on('dialog', (d) => d.accept().catch(() => {}))
          p.setDefaultTimeout(20_000)
          await p.setViewportSize({ width: 1600, height: 900 }).catch(() => {})
          return { child, browser, page: p }
        }
        await new Promise((r) => setTimeout(r, 500))
      }
    } catch {
      /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('o app não subiu (ver app-*.log na pasta da rodada)')
}

async function stopDev(inst) {
  await inst.browser.close().catch(() => {})
  await shutdown({ close: async () => {}, process: () => ({ pid: inst.child.pid }) }, DATA, { log })
}

// ---------- escritório ----------

const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).then(() => log(`print ${name}.png`))
const panel = (page) => page.getByRole('dialog', { name: 'Diário do Scrum Master' })

async function openOffice(page) {
  await page.waitForTimeout(2500)
  await page.getByRole('tab', { name: /Escritório/ }).click()
  await page.waitForSelector('[data-testid="office3d-canvas"]')
  await page.waitForTimeout(2000)
  await page.getByRole('button', { name: 'Minimizar o chat do Escritório' }).click({ timeout: 3000 }).catch(() => {})
  await page.mouse.click(800, 450)
  await page.keyboard.press('Control+Alt+Shift+D')
  await page.waitForTimeout(3000)
  const found = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="office3d-canvas"]')
    const k = Object.keys(canvas).find((x) => x.startsWith('__reactFiber$'))
    window.__o = null
    for (let f = canvas[k]; f && !window.__o; f = f.return) {
      for (let h = f.memoizedState; h && typeof h === 'object' && 'next' in h; h = h.next) {
        const v = h.memoizedState
        if (v && typeof v === 'object' && v.current && v.current.rig && v.current.board) window.__o = v.current
      }
    }
    return !!window.__o
  })
  if (!found) throw new Error('motor do escritório não achado')
  // Espera o elenco de avatares carregar (cada papel o seu GLB).
  let n = -1
  for (let i = 0; i < 150; i++) {
    const now = await page.evaluate(() => [...window.__o.scene.chars.values()].filter((c) => !!c.body.avatar).length)
    if (now > 0 && now === n) break
    n = now
    await page.waitForTimeout(250)
  }
}

const smList = (page) =>
  page.evaluate(() =>
    [...window.__o.scene.chars.values()]
      .filter((c) => c.key.startsWith('scrum:'))
      .map((c) => ({ key: c.key, avatar: !!c.body.avatar, x: +c.brain.x.toFixed(2), z: +c.brain.z.toFixed(2), errand: c.brain.errand?.state ?? null }))
  )

/** Câmera parada perto de `key` (sem o reenquadramento automático da demo). */
const aim = (page, key, distance, yaw = 0.5, pitch = 0.25, ty = 1.0) =>
  page.evaluate(({ key, distance, yaw, pitch, ty }) => {
    const e = window.__o
    const b = e.scene.chars.get(key).brain
    e.autoFrame = false
    e.rig.pose = { tx: b.x, ty, tz: b.z, yaw: b.yaw + Math.PI + yaw, pitch, distance }
    e.requestRender()
  }, { key, distance, yaw, pitch, ty })

/** O clique de verdade no personagem: o ponto da cabeça na tela. */
async function clickChar(page, key) {
  await aim(page, key, 3.4, 0.4, 0.2, 1.1)
  await page.waitForTimeout(1500)
  const pt = await page.evaluate((key) => {
    const e = window.__o
    const c = e.scene.chars.get(key)
    const v = c.group.position.clone()
    v.y += 1.25
    v.project(e.camera)
    const r = document.querySelector('[data-testid="office3d-canvas"]').getBoundingClientRect()
    return { x: r.x + ((v.x + 1) / 2) * r.width, y: r.y + ((1 - v.y) / 2) * r.height }
  }, key)
  await page.mouse.click(pt.x, pt.y)
  return pt
}

/** Um SM parado no lugar dele (a demo manda visitas a cada 18 s). */
async function idleSm(page) {
  for (let i = 0; i < 60; i++) {
    const sm = (await smList(page)).find((s) => !s.errand)
    if (sm) return sm.key
    await page.waitForTimeout(500)
  }
  throw new Error('nenhum SM parado no lugar')
}

async function openPanel(page, label) {
  const key = await idleSm(page)
  const pt = await clickChar(page, key)
  const ok = await panel(page).waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false)
  check(`${label}: clique no SM (${key}) abre o painel`, ok, `ponto ${Math.round(pt.x)},${Math.round(pt.y)}`)
  if (!ok) {
    await page.evaluate((k) => window.__o.focus(k, true), key)
    await panel(page).waitFor({ state: 'visible' })
  }
  return key
}

const histFlags = (page) => panel(page).getByTestId('smp-ev-flag').allInnerTexts()

async function waitSmReply(page, before, label) {
  const sm = panel(page).locator('[data-testid="smp-chat-msg"][data-role="sm"]')
  for (let i = 0; i < 240; i++) {
    if ((await sm.count()) > before) break
    await page.waitForTimeout(1000)
  }
  const n = await sm.count()
  const text = n > before ? (await sm.nth(n - 1).innerText()).trim() : ''
  const err = (await panel(page).locator('.smp-err').allInnerTexts()).join(' | ')
  check(`${label}: o SM responde`, n > before, text ? text.slice(0, 400).replace(/\s+/g, ' ') : err || 'sem resposta em 240 s')
  return text
}

// ---------- roteiro ----------

async function measureFrames(page) {
  await page.keyboard.press('Control+Alt+Shift+P')
  await page.evaluate(() => {
    const e = window.__o
    e.resetView()
    e.__spin = setInterval(() => {
      e.rig.orbit(0.6, 0)
      e.requestRender()
    }, 16)
  })
  await page.waitForTimeout(2500)
  const samples = []
  for (let i = 0; i < SECS; i++) {
    await page.waitForTimeout(1000)
    samples.push(await page.evaluate(() => ({ ...window.__o.stats })))
  }
  await page.evaluate(() => clearInterval(window.__o.__spin))
  await page.keyboard.press('Control+Alt+Shift+P')
  const avg = (k) => +(samples.reduce((s, x) => s + x[k], 0) / samples.length).toFixed(2)
  const max = (k) => +Math.max(...samples.map((x) => x[k])).toFixed(2)
  const chars = await page.evaluate(() => window.__o.scene.chars.size)
  const visivel = await page.evaluate(() => document.visibilityState)
  result.medidas.quadro = { segundos: SECS, personagens: chars, visivel, fps: avg('fps'), frameMs: avg('frameMs'), frameP95: avg('frameP95'), frameP95max: max('frameP95'), workMs: avg('workMs'), workP95: avg('workP95'), calls: Math.round(avg('calls')), triangles: Math.round(avg('triangles')) }
  log(`tempo de quadro (demo de 5 salas): ${JSON.stringify(result.medidas.quadro)}`)
}

async function sceneAndVisit(page) {
  const sms = await smList(page)
  result.medidas.sms = sms
  check('um SM por sala com quadro na demo, com o avatar', sms.length > 0 && sms.every((s) => s.avatar), `${sms.length} SMs: ${sms.map((s) => s.key).join(', ')}`)
  const first = sms.find((s) => !s.errand) ?? sms[0]
  // A sala inteira (o SM ao lado do quadro) e o SM de perto (a camisa na cor do projeto).
  await page.evaluate(() => document.querySelector('.o3d-chat')?.style.setProperty('display', 'none'))
  await aim(page, first.key, 6.5, 0.9, 0.45, 1.0)
  await page.waitForTimeout(1500)
  await shot(page, '10-sm-na-sala')
  await aim(page, first.key, 2.4, 0.45, 0.2, 1.1)
  await page.waitForTimeout(1500)
  await shot(page, '10-sm-de-perto')
  // A visita da demo: o SM ao lado da mesa do agente, com o balão.
  let visit = null
  for (let i = 0; i < 90 && !visit; i++) {
    visit = (await smList(page)).find((s) => s.errand === 'act') ?? null
    if (!visit) await page.waitForTimeout(1000)
  }
  check('a visita da demo leva o SM à mesa do agente', !!visit, visit ? `${visit.key} em ${visit.x},${visit.z}` : 'nenhuma visita em 90 s')
  if (visit) {
    await page.waitForTimeout(1200)
    await aim(page, visit.key, 3.6, 0.7, 0.3, 1.0)
    await page.waitForTimeout(1500)
    await shot(page, '11-sm-visita')
  }
  await page.evaluate(() => document.querySelector('.o3d-chat')?.style.removeProperty('display'))
}

async function panelFlow(page) {
  const key = await openPanel(page, 'primeira abertura')
  check('o chat flutuante some com o painel aberto', (await page.locator('.o3d-chat').count()) === 0)
  const vazio = panel(page).getByText('Nenhum envio de handoff em andamento agora.')
  check('Agora: vazio sem envio em andamento', await vazio.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false))
  await shot(page, '12-painel-agora')
  // A prévia ao passar o mouse no SM com o painel aberto.
  const pt = await page.evaluate((key) => {
    const e = window.__o
    const v = e.scene.chars.get(key).group.position.clone()
    v.y += 1.25
    v.project(e.camera)
    const r = document.querySelector('[data-testid="office3d-canvas"]').getBoundingClientRect()
    return { x: r.x + ((v.x + 1) / 2) * r.width, y: r.y + ((1 - v.y) / 2) * r.height }
  }, key)
  await page.mouse.move(pt.x, pt.y)
  await page.waitForTimeout(1500)
  result.notas.push(`prévia ao passar o mouse no SM com o painel aberto: ${(await page.locator('.o3d-preview-anchor').count()) > 0 ? 'aparece' : 'não aparece'}`)
  log(result.notas.at(-1))
  await page.mouse.move(5, 5)

  await panel(page).getByRole('tab', { name: /Histórico/ }).click()
  const cut = panel(page).locator('[data-testid="smp-ev"][data-tipo="parou"]')
  check('Histórico: o corte aparece', (await cut.count()) === 1, (await cut.first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300))
  const days = await panel(page).getByTestId('smp-day').evaluateAll((els) => els.map((e) => e.querySelector('.smp-h')?.textContent + ' | ' + e.textContent.slice(0, 120)))
  check('Histórico: Hoje aberto e Ontem fechado com o resumo', days.length === 2 && /Hoje/.test(days[0]) && /mostrar/.test(days[1]), days.join(' || '))
  await shot(page, '13-painel-historico')

  await cut.getByRole('button', { name: 'Questionar' }).click()
  check('Questionar leva à Conversa com o "Sobre:" do corte', (await panel(page).locator('.smp-ctx-chip').innerText()).includes('corte em smproj'))
  const box = panel(page).getByRole('textbox', { name: 'Pergunta ao Scrum Master' })
  await box.fill('Por que você cortou este envio? O check.js falhava de propósito: era o teste pedido na etapa.')
  await panel(page).getByRole('button', { name: 'Enviar' }).click()
  result.respostaPergunta = await waitSmReply(page, 0, 'pergunta')
  await shot(page, '14-painel-conversa-resposta')

  await box.fill('Corte errado: o laço do check.js era o próprio teste da etapa; não trate isso como fuga.')
  await panel(page).getByRole('button', { name: 'Marcar como corte errado' }).click()
  result.respostaContestacao = await waitSmReply(page, 1, 'contestação')
  await shot(page, '15-painel-conversa-contestado')

  await panel(page).getByRole('tab', { name: /Histórico/ }).click()
  await page.waitForTimeout(1500)
  const flags = await histFlags(page)
  const badge = await panel(page).locator('.smp-badge').allInnerTexts()
  check('Histórico: a marca de contestado com a frase', flags.length === 1 && flags[0].includes('o laço do check.js era o próprio teste'), flags.join(' | '))
  check('o selo "1 contestado" na aba', badge.some((b) => /1 contestado/.test(b)), badge.join(' | '))
  await shot(page, '16-historico-contestado')
}

/** Fecha (✕, se aberto) e reabre o painel, confere a marca e a conversa, e fecha com Esc. */
async function reopenCheck(page, label) {
  if ((await panel(page).count()) > 0) {
    await page.getByRole('button', { name: 'Fechar' }).first().click()
    check(`${label}: ✕ fecha o painel e o chat flutuante volta`, (await panel(page).count()) === 0 && (await page.locator('.o3d-chat').count()) > 0)
  } else {
    check(`${label}: o painel começa fechado`, (await page.locator('.o3d-chat').count()) > 0)
  }
  await openPanel(page, label)
  await panel(page).getByRole('tab', { name: /Histórico/ }).click()
  await page.waitForTimeout(1500)
  const flags = await histFlags(page)
  check(`${label}: a marca de contestado continua`, flags.length === 1, flags.join(' | '))
  await panel(page).getByRole('tab', { name: /Conversa com o SM/ }).click()
  const msgs = await panel(page).getByTestId('smp-chat-msg').count()
  check(`${label}: a conversa com o SM continua (4 mensagens)`, msgs === 4, `${msgs} mensagens`)
  await page.keyboard.press('Escape')
  check(`${label}: Esc fecha o painel`, (await panel(page).count()) === 0)
}

/** O diário ilegível (vira pasta) mostra o erro; de volta, o Histórico volta. */
async function errorCheck(page) {
  await openPanel(page, 'erro de leitura')
  await panel(page).getByRole('tab', { name: /Histórico/ }).click()
  renameSync(LOGF, `${LOGF}.bak`)
  mkdirSync(LOGF)
  await panel(page).getByRole('button', { name: '30 dias' }).click()
  const err = panel(page).getByText(/Não deu para ler o diário/)
  const shown = await err.waitFor({ state: 'visible', timeout: 25_000 }).then(() => true, () => false)
  check('diário ilegível: o painel mostra o erro', shown, shown ? (await err.innerText()).slice(0, 200) : '')
  if (shown) await shot(page, '17-historico-erro')
  rmSync(LOGF, { recursive: true, force: true })
  renameSync(`${LOGF}.bak`, LOGF)
  await panel(page).getByRole('button', { name: '7 dias' }).click()
  const back = await panel(page).locator('[data-testid="smp-ev"][data-tipo="parou"]').waitFor({ state: 'visible', timeout: 25_000 }).then(() => true, () => false)
  check('diário de volta: o Histórico volta', back)
  await page.keyboard.press('Escape')
}

async function main() {
  mkdirSync(BASE, { recursive: true })
  writeFileSync(LOG, '')
  seed()
  let inst = await launchDev('1')
  try {
    const { page } = inst
    await page.evaluate((patch) => window.api.setConfig(patch), {
      board: { po: { enabled: false }, scrumMaster: { enabled: true, model: 'claude-sonnet-5-5', podeParar: true } },
      vigia: { enabled: false },
      memorista: { enabled: false },
      typesafe: { enabled: false }
    })
    await openOffice(page)
    await sceneAndVisit(page)
    await measureFrames(page)
    await panelFlow(page)
    await reopenCheck(page, 'fechar e reabrir')
    await page.reload()
    await page.waitForFunction(() => !!window.api, null, { timeout: 60_000 })
    await openOffice(page)
    await reopenCheck(page, 'depois do F5')
    await errorCheck(page)
  } catch (err) {
    log(`ERRO: ${err?.stack ?? err}`)
    result.erro = String(err?.message ?? err)
    await shot(inst.page, 'zz-erro').catch(() => {})
  } finally {
    await stopDev(inst)
  }
  if (!result.erro) {
    inst = await launchDev('2')
    try {
      await openOffice(inst.page)
      await reopenCheck(inst.page, 'app reiniciado')
      await openPanel(inst.page, 'app reiniciado (print)')
      await panel(inst.page).getByRole('tab', { name: /Histórico/ }).click()
      await inst.page.waitForTimeout(1200)
      await shot(inst.page, '18-reiniciado-contestado')
    } catch (err) {
      log(`ERRO (reinício): ${err?.stack ?? err}`)
      result.erro = String(err?.message ?? err)
      await shot(inst.page, 'zz-erro-reinicio').catch(() => {})
    } finally {
      await stopDev(inst)
    }
  }
  if (existsSync(CHATF)) writeFileSync(path.join(OUT, 'painel-conversa.jsonl'), readFileSync(CHATF, 'utf8'))
  const failed = Object.entries(result.checks).filter(([, ok]) => !ok).map(([k]) => k)
  result.resumo = { checks: Object.keys(result.checks).length, falharam: failed }
  writeFileSync(path.join(OUT, 'painel-resultado.json'), JSON.stringify(result, null, 2))
  log(`fim: ${Object.keys(result.checks).length - failed.length}/${Object.keys(result.checks).length} ok; falharam: ${failed.join('; ') || 'nenhum'}; dados em ${BASE}`)
}

await main()
