// Validação do aviso "Uma implantação está rodando neste projeto…" no app real, numa instância
// ISOLADA (scripts/replay/instance.mjs): pasta de dados própria em %TEMP%, projeto descartável em
// %TEMP%. Nunca toca o app instalado nem os dados reais (%APPDATA%\agent-code-desktop).
//
// Plano de 1 prompt [espera]: o agente roda `node espera.js` (5 min) em primeiro plano.
//  1. Plano rodando (turno ativo): a conversa avulsa da pasta MOSTRA o aviso.
//  2. Interrompe o turno (Stop): sem turno nem escrita há 3 min o plano vira "parado" —
//     a avulsa NÃO mostra o aviso.
//  Em cada estado: sair da conversa e voltar, e recarregar (F5), e conferir de novo.
//
// Uso: node docs/validation/aviso-implantacao-2026-10/validar-aviso.mjs
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launch, seedDataDir, openProject, shutdown, waitForMemory, APP_ROOT } from '../../../scripts/replay/instance.mjs'
import { pump } from '../../../scripts/replay/drive.mjs'
import { reopenPlan, releaseHeldHandoff } from '../../../scripts/replay/planningUi.mjs'

const OUT = path.join(APP_ROOT, 'docs', 'validation', 'aviso-implantacao-2026-10')
const BASE = path.join(os.tmpdir(), `aviso-val-${Date.now()}`)
const DATA = path.join(BASE, 'data')
const PROJ = path.join(BASE, 'avisoproj')
const SLUG = 'plano-aviso-val'
const AVISO = 'Uma implantação está rodando neste projeto'
// A conversa avulsa nasce com o título padrão (qualquer "Nova conversa" da pasta é avulsa).
const AVULSA = 'Nova conversa'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const LOG = path.join(OUT, 'execucao.log')
const log = (line) => {
  const l = `[${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s] ${line}`
  console.log(l)
  appendFileSync(LOG, `${l}\n`)
}

const PROMPT = `# Etapa [espera] — Esperar o serviço de teste

Projeto de TESTE, numa pasta descartável.

1. Crie o item "[espera] Esperar o serviço de teste" na sua lista de tarefas (TodoWrite) e marque em andamento.
2. Rode \`node espera.js\` com a ferramenta Bash, em primeiro plano, com timeout 600000 (leva uns 5 minutos). Não use segundo plano.
3. Depois crie o arquivo a.txt com o conteúdo "ok", marque a tarefa como concluída e encerre com uma linha.
`

function prepare() {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(PROJ, { recursive: true })
  writeFileSync(path.join(PROJ, 'espera.js'), "setTimeout(() => console.log('espera concluída.'), 300000)\n")
  const git = (...args) => execFileSync('git', ['-C', PROJ, '-c', 'user.name=validacao', '-c', 'user.email=validacao@example.invalid', ...args], { stdio: 'ignore' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'script de teste')
  const plan = path.join(BASE, 'plan-src', SLUG)
  mkdirSync(path.join(plan, '_handoff'), { recursive: true })
  mkdirSync(path.join(plan, 'cards'), { recursive: true })
  writeFileSync(path.join(plan, '_roteiro.md'), '# Validação do aviso\n<!-- rev: 1 -->\n\n- [pendente] espera: Esperar o serviço de teste\n<!-- est espera: 30 -->\n')
  writeFileSync(path.join(plan, '_handoff', '2026-10-11-01.md'), PROMPT)
  writeFileSync(path.join(plan, '_handoff', '2026-10-11-01.meta.json'), JSON.stringify({ etapas: ['espera'] }, null, 2))
  seedDataDir(DATA, { plan: { from: plan, projectKey: 'avisoproj', slug: SLUG } })
}

async function sendPlan(page) {
  await page.locator('.pl-handoff-btn').first().click()
  const dialog = page.locator('[role="dialog"][aria-labelledby="pl-handoff-title"]')
  await dialog.waitFor({ state: 'visible' })
  const anyway = dialog.getByLabel(/Enviar mesmo assim/)
  if (await anyway.count()) await anyway.check().catch(() => undefined)
  const review = dialog.getByRole('button', { name: /^Revisar (prompt|\d+ prompts)$/ }).first()
  if (await review.count()) await review.click().catch(() => undefined)
  await dialog.locator('textarea[aria-label^="Prompt "]').first().waitFor({ state: 'visible', timeout: 30_000 })
  const fast = dialog.getByLabel(/Fast mode/i)
  if ((await fast.count()) && (await fast.isChecked())) await fast.uncheck()
  await dialog.getByRole('button', { name: /^Enviar para implementação$/ }).last().click()
  await dialog.waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => undefined)
}

/** A foto da fila do projeto que o renderer recebe (a mesma do aviso). */
async function folderOf(page) {
  const r = await page.evaluate(() => window.api.handoffProjectStatus()).catch(() => null)
  const f = r?.ok ? r.snapshot.folders[0] : null
  return f ? { implantacaoEmCurso: f.implantacaoEmCurso, planos: f.plans.map((p) => `${p.planTitulo}:${p.estado}`) } : null
}

/** O aviso na tela da conversa ativa: o texto do .project-queue-notice ou null. */
async function noticeText(page) {
  const n = page.locator('.project-queue-notice')
  return (await n.count()) ? (await n.first().innerText()).trim() : null
}

// Só as linhas do grupo do projeto descartável: o Sandbox também tem "Nova conversa".
const row = (page, text) =>
  page.locator('.project-item').filter({ has: page.locator('.project-name', { hasText: 'avisoproj' }) }).locator('.conv-row').filter({ hasText: text }).first()

async function openAvulsa(page) {
  await row(page, AVULSA).click()
  await sleep(1500)
}

const checks = []
async function check(page, id, cenario, esperaAviso, shot) {
  const projeto = (await page.locator('.conv-row.active').first().innerText().catch(() => '')).trim()
  const texto = await noticeText(page)
  const folder = await folderOf(page)
  const temAviso = !!texto && texto.includes(AVISO)
  const ok = temAviso === esperaAviso
  await page.screenshot({ path: path.join(OUT, `${shot}.png`) }).catch((err) => log(`print ${shot} falhou: ${err?.message}`))
  checks.push({ id, cenario, esperaAviso, temAviso, ok, aviso: texto, conversaAtiva: projeto, folder, print: `${shot}.png` })
  log(`${ok ? 'OK ' : 'FALHOU'} ${id} ${cenario}: aviso=${temAviso} (esperado ${esperaAviso}); fila=${JSON.stringify(folder)}`)
}

/** Sair da avulsa (para a conversa do plano) e voltar; depois F5 e voltar à avulsa. */
async function remountAndReload(page, id, esperaAviso, prefix) {
  await row(page, 'Implementa').click()
  await sleep(1500)
  await openAvulsa(page)
  await check(page, `${id}b`, 'saiu e voltou à avulsa', esperaAviso, `${prefix}-b-voltou`)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await row(page, AVULSA).waitFor({ state: 'visible', timeout: 60_000 })
  await sleep(3000)
  await openAvulsa(page)
  await check(page, `${id}c`, 'F5 e avulsa de novo', esperaAviso, `${prefix}-c-f5`)
}

async function waitFolder(page, bridge, ctx, pred, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    await pump(bridge, ctx, log).catch(() => undefined)
    await releaseHeldHandoff(page).catch(() => undefined)
    last = await folderOf(page)
    if (last && pred(last)) return last
    await sleep(3000)
  }
  throw new Error(`tempo esgotado esperando ${label}; última foto: ${JSON.stringify(last)}`)
}

async function main() {
  writeFileSync(LOG, '')
  prepare()
  log(`dados ${DATA}; projeto ${PROJ}`)
  await waitForMemory(4, { log })
  const { app, page, bridge } = await launch(DATA, { log })
  const ctx = { answered: new Set(), events: [], policy: { worktree: PROJ, writable: [PROJ], forbidden: [APP_ROOT] } }
  const result = { checks }
  try {
    await page.evaluate((patch) => window.api.setConfig(patch), {
      board: { po: { enabled: false }, scrumMaster: { enabled: false } },
      vigia: { enabled: false },
      memorista: { enabled: false },
      typesafe: { enabled: false }
    })
    await openProject(app, page, PROJ)
    await reopenPlan(page, SLUG)
    await sendPlan(page)
    log('plano enviado para implementação')

    // 1. Rodando: turno ativo com o espera.js.
    await waitFolder(page, bridge, ctx, (f) => f.planos[0]?.endsWith(':rodando'), 5 * 60_000, 'plano rodando')
    const impl = ((await bridge.state()).conversations ?? []).find((c) => /Implementa/i.test(c.title ?? ''))
    result.conversaPlano = impl ? { id: impl.id, title: impl.title } : null
    const created = await bridge.createConversation(PROJ)
    log(`avulsa criada: ${JSON.stringify(created)}`)
    await sleep(2000)
    await openAvulsa(page)
    await check(page, '1a', 'plano rodando — avulsa da pasta', true, '01-rodando-a-avulsa')
    await remountAndReload(page, '1', true, '01-rodando')

    // 2. Parado: Stop no turno; sem turno nem escrita há 3 min vira "parado".
    if (impl) await page.evaluate((id) => window.api.interrupt(id), impl.id)
    log('turno do plano interrompido (Stop)')
    const parado = await waitFolder(page, bridge, ctx, (f) => !f.implantacaoEmCurso && f.planos[0]?.endsWith(':parado'), 8 * 60_000, 'plano parado')
    log(`fila parada: ${JSON.stringify(parado)}`)
    await openAvulsa(page)
    await check(page, '2a', 'plano parado — avulsa da pasta', false, '02-parado-a-avulsa')
    await remountAndReload(page, '2', false, '02-parado')
    // A conversa do próprio plano continua com o aviso dela (não é a avulsa).
    await row(page, 'Implementa').click()
    await sleep(1500)
    result.avisoDaConversaDoPlano = await noticeText(page)
    await page.screenshot({ path: path.join(OUT, '03-parado-conversa-do-plano.png') })
  } catch (err) {
    log(`ERRO: ${err?.stack ?? err}`)
    result.erro = String(err?.message ?? err)
    await page.screenshot({ path: path.join(OUT, 'zz-erro.png') }).catch(() => undefined)
  } finally {
    await shutdown(app, DATA, { log }).catch(() => undefined)
  }
  writeFileSync(path.join(OUT, 'resultado.json'), JSON.stringify(result, null, 2))
  log(`fim: ${checks.filter((c) => c.ok).length}/${checks.length} OK${result.erro ? ` — erro: ${result.erro}` : ''}; dados em ${BASE}`)
}

await main()
