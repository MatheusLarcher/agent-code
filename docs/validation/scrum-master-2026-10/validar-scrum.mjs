// Validação do Scrum Master no app real, numa instância ISOLADA (scripts/replay/instance.mjs):
// pasta de dados própria em %TEMP%, projeto descartável em %TEMP%, prazo encurtado por
// AGENT_CODE_SCRUM_ESCALA=0.05. Nunca toca o app instalado nem o banco do usuário.
//
// Plano de 2 etapas, um prompt por etapa (já gravados em _handoff/, o diálogo abre no passo 3):
//  - envio 1 [laco], 80 min no plano → prazo 4 min: tick.js a cada 20 s (cobranças 150/200% pelo
//    hook), depois entrega_aviso_demora(5) + espera.js de ~4 min (travado DENTRO do declarado:
//    não corta), depois check.js que sempre falha (laço) até o 300% (PARAR → parada; a fila segura);
//  - "Enviar mesmo assim" → envio 2 [arquivo-b], 20 min → prazo 1 min: lento.js de 4 min sem
//    declaração (travado → o modelo julga; DESVIO/PARAR corta e reenvia) e depois cria b.txt.
//
// Uso: node docs/validation/scrum-master-2026-10/validar-scrum.mjs
import { execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launch, seedDataDir, openProject, shutdown, waitForMemory, APP_ROOT } from '../../../scripts/replay/instance.mjs'
import { pump } from '../../../scripts/replay/drive.mjs'
import { reopenPlan, releaseHeldHandoff } from '../../../scripts/replay/planningUi.mjs'
import { collectTranscripts } from '../../../scripts/replay/measure.mjs'

const OUT = path.join(APP_ROOT, 'docs', 'validation', 'scrum-master-2026-10')
const BASE = path.join(os.tmpdir(), `sm-val-${Date.now()}`)
const DATA = path.join(BASE, 'data')
const PROJ = path.join(BASE, 'smproj')
const SLUG = 'plano-sm-val'
const LIMIT_MS = 55 * 60_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const stamp = () => `${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s`
const LOG = path.join(OUT, 'execucao.log')
const log = (line) => {
  const l = `[${stamp()}] ${line}`
  console.log(l)
  appendFileSync(LOG, `${l}\n`)
}

// ---------- projeto descartável e plano ----------

const SCRIPTS = {
  'tick.js': `const fs = require('fs'), p = require('path')
const f = p.join(__dirname, '.start')
if (!fs.existsSync(f)) fs.writeFileSync(f, String(Date.now()))
const t0 = Number(fs.readFileSync(f, 'utf8'))
setTimeout(() => {
  const s = Math.round((Date.now() - t0) / 1000)
  const next = s >= 400
    ? 'FASE 2: chame agora a ferramenta entrega_aviso_demora com minutos=5 e motivo="espera.js aguarda o serviço de teste subir"; depois rode \`node espera.js\` em primeiro plano com timeout 600000.'
    : 'FASE 1: rode \`node tick.js\` de novo.'
  console.log('tick ' + s + 's. ' + next)
}, 20000)
`,
  'espera.js': `setTimeout(() => console.log('espera concluída. FASE 3: rode \`node check.js\` até passar.'), 250000)
`,
  'check.js': `setTimeout(() => { console.log('check: FALHOU — esperado 42, recebido 41. Rode \`node check.js\` de novo.'); process.exit(1) }, 15000)
`,
  'lento.js': `setTimeout(() => console.log('lento concluído.'), 240000)
`
}

const ROTEIRO = `# Validação do Scrum Master
<!-- rev: 1 -->

- [pendente] laco: Laço de verificação (tick, espera e check)
<!-- est laco: 80 -->
- [pendente] arquivo-b: Criar b.txt
<!-- est arquivo-b: 20 -->
`

const PROMPT_1 = `# Etapa [laco] — Laço de verificação

Projeto de TESTE, numa pasta descartável. Siga o roteiro à risca; quem dita o próximo passo são os scripts.

1. Crie o item "[laco] Laço de verificação" na sua lista de tarefas (TodoWrite) e marque em andamento.
2. Rode \`node tick.js\` com a ferramenta Bash. Cada saída diz a FASE e o próximo comando: faça exatamente o que ela disser, uma chamada por vez, em primeiro plano (nada em segundo plano, nada em paralelo).
3. Na FASE 3, \`node check.js\` precisa passar para a etapa terminar. Não leia nem edite os scripts e não investigue a causa: só rode de novo. A cada tentativa escreva UMA linha de texto: "Tentativa N: check.js falhou com o mesmo erro, vou tentar de novo."
4. Não encerre o turno nem pergunte nada enquanto check.js não passar. Se aparecer um aviso ou cobrança no contexto, responda em uma linha e continue o passo em que está.
`

const PROMPT_2 = `# Etapa [arquivo-b] — Criar b.txt

1. Crie o item "[arquivo-b] Criar b.txt" na sua lista de tarefas (TodoWrite) e marque em andamento.
2. Rode \`node lento.js\` com a ferramenta Bash, em primeiro plano, com timeout 600000 (leva uns 4 minutos). Não use segundo plano e não chame entrega_aviso_demora nesta etapa.
3. Depois, crie o arquivo b.txt com o conteúdo "ok", marque a tarefa como concluída e encerre com uma linha de resumo.
`

function prepare() {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(PROJ, { recursive: true })
  for (const [name, body] of Object.entries(SCRIPTS)) writeFileSync(path.join(PROJ, name), body)
  writeFileSync(path.join(PROJ, '.gitignore'), '.start\n')
  const git = (...args) => execFileSync('git', ['-C', PROJ, ...args], { stdio: 'ignore' })
  git('init', '-q')
  git('-c', 'user.name=validacao', '-c', 'user.email=validacao@example.invalid', 'add', '-A')
  git('-c', 'user.name=validacao', '-c', 'user.email=validacao@example.invalid', 'commit', '-q', '-m', 'scripts de teste')
  const plan = path.join(BASE, 'plan-src', SLUG)
  mkdirSync(path.join(plan, '_handoff'), { recursive: true })
  mkdirSync(path.join(plan, 'cards'), { recursive: true })
  writeFileSync(path.join(plan, '_roteiro.md'), ROTEIRO)
  writeFileSync(path.join(plan, '_handoff', '2026-10-11-01.md'), PROMPT_1)
  writeFileSync(path.join(plan, '_handoff', '2026-10-11-01.meta.json'), JSON.stringify({ etapas: ['laco'] }, null, 2))
  writeFileSync(path.join(plan, '_handoff', '2026-10-11-02.md'), PROMPT_2)
  writeFileSync(path.join(plan, '_handoff', '2026-10-11-02.meta.json'), JSON.stringify({ etapas: ['arquivo-b'] }, null, 2))
  seedDataDir(DATA, { plan: { from: plan, projectKey: 'smproj', slug: SLUG } })
}

// ---------- evidências ----------

let diaryPath = null
function findDiary(dir = DATA, depth = 0) {
  if (depth > 5 || !existsSync(dir)) return null
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isFile() && e.name === 'scrum-decisions.log') return p
    if (e.isDirectory() && !['pgdata', 'node_modules', 'perfil'].includes(e.name)) {
      const found = findDiary(p, depth + 1)
      if (found) return found
    }
  }
  return null
}

function diary() {
  diaryPath ??= findDiary()
  if (!diaryPath || !existsSync(diaryPath)) return []
  return readFileSync(diaryPath, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)]
    } catch {
      return []
    }
  })
}

const shots = new Set()
async function shot(page, name) {
  if (shots.has(name)) return
  shots.add(name)
  await page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch((err) => log(`print ${name} falhou: ${err?.message}`))
  log(`print ${name}.png`)
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
  await shot(page, '00-handoff-2-prompts')
  const fast = dialog.getByLabel(/Fast mode/i)
  if ((await fast.count()) && (await fast.isChecked())) await fast.uncheck()
  await dialog.getByRole('button', { name: /^Enviar para implementação$/ }).last().click()
  await dialog.waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => undefined)
}

const userTexts = async (bridge, convId) =>
  ((await bridge.history(convId).catch(() => ({}))).messages ?? []).filter((m) => m?.kind === 'user').map((m) => String(m.text ?? ''))

// ---------- condução ----------

async function main() {
  writeFileSync(LOG, '')
  prepare()
  log(`dados ${DATA}; projeto ${PROJ}`)
  await waitForMemory(4, { log })
  process.env.AGENT_CODE_SCRUM_ESCALA = '0.05'
  const { app, page, bridge } = await launch(DATA, { log })
  const ctx = { answered: new Set(), events: [], policy: { worktree: PROJ, writable: [PROJ], forbidden: [APP_ROOT] } }
  const result = { cenarios: {}, notas: [] }
  try {
    await page.evaluate((patch) => window.api.setConfig(patch), {
      board: { po: { enabled: false }, scrumMaster: { enabled: true, model: 'claude-sonnet-5-5', podeParar: true } },
      vigia: { enabled: false },
      memorista: { enabled: false },
      typesafe: { enabled: false }
    })
    const cfg = await page.evaluate(() => window.api.getConfig())
    log(`config do Scrum Master: ${JSON.stringify(cfg.board?.scrumMaster ?? null)}`)
    await openProject(app, page, PROJ)
    await reopenPlan(page, SLUG)
    await sendPlan(page)
    log('plano enviado para implementação')
    for (let i = 0; i < 10 && !(await releaseHeldHandoff(page)); i++) await sleep(1000)

    let conv = null
    let seen = 0
    let phase = 'envio1'
    let stopAt = 0
    let toastN = 0
    while (Date.now() - t0 < LIMIT_MS) {
      const state = await pump(bridge, ctx, log).catch(() => ({ conversations: [] }))
      conv ??= (state.conversations ?? []).find((c) => c.mode !== 'planning' && /Implementa/i.test(c.title ?? '')) ?? null
      const rows = diary()
      for (const r of rows.slice(seen)) {
        log(`DIÁRIO ${r.tipo} etapa=${r.etapaId} marco=${r.marco} veredito=${r.veredito ?? '-'} tipo=${r.tipoDesvio ?? '-'} motivo=${(r.motivo ?? '').slice(0, 160)}`)
        if (r.tipo === 'deixou-seguir' && r.marco === 'travado' && r.declaradoMin) {
          result.cenarios.declaradoSemCorte = true
          await shot(page, '05-declarado-sem-corte')
        }
      }
      seen = rows.length
      // O aviso `scrum` na tela (toast): um print por texto novo, até 4.
      const toast = page.locator('.toast').filter({ hasText: /Scrum Master/ })
      if ((await toast.count().catch(() => 0)) > 0 && toastN < 4) {
        const text = (await toast.first().innerText().catch(() => '')).trim()
        if (text && !result.notas.includes(text)) {
          result.notas.push(text)
          toastN++
          log(`TOAST ${text}`)
          await shot(page, `02-aviso-scrum-${toastN}`)
        }
      }
      if (phase === 'envio1' && rows.some((r) => r.tipo === 'parou')) {
        phase = 'parado'
        stopAt = Date.now()
        result.cenarios.parada300 = true
        await sleep(8000)
        await shot(page, '03-parada-300')
      }
      if (phase === 'envio1' && rows.some((r) => r.marco === 300 && r.etapaId === 'laco' && r.tipo !== 'parou') && !rows.some((r) => r.tipo === 'parou')) {
        // 300% veio sem PARAR: o envio não para sozinho; segue para o envio 2 do mesmo jeito.
        phase = 'parado'
        stopAt = Date.now()
        result.cenarios.parada300 = false
        log('ATENÇÃO: o 300% não veio com PARAR — sem parada; paro o envio 1 pelo Stop e sigo')
        if (conv) await page.evaluate((id) => window.api.interrupt(id), conv.id).catch(() => undefined)
      }
      if (phase === 'parado' && Date.now() - stopAt > 60_000) {
        // A fila segurou 1 min: o prompt 2 não saiu sozinho.
        const texts = conv ? await userTexts(bridge, conv.id) : []
        result.cenarios.filaSegurou = !texts.some((t) => t.includes('Etapa [arquivo-b]'))
        log(`fila segurou 60 s: ${result.cenarios.filaSegurou}`)
        await shot(page, '03-fila-segura')
        const btn = page.getByRole('button', { name: 'Enviar mesmo assim' }).first()
        if (await btn.count()) await btn.click().catch((err) => log(`Enviar mesmo assim falhou: ${err?.message}`))
        else if (conv) {
          log('ATENÇÃO: botão "Enviar mesmo assim" não encontrado — mando o prompt 2 pela ponte')
          await bridge.send(conv.id, PROMPT_2)
        }
        phase = 'envio2'
        log('envio 2 liberado')
      }
      if (phase === 'envio2') {
        const travado = rows.filter((r) => r.etapaId === 'arquivo-b' && r.marco === 'travado')
        if (travado.some((r) => r.tipo === 'interrompeu') && !shots.has('04-corte')) {
          result.cenarios.corteTravado = true
          await sleep(15_000)
          await shot(page, '04-corte')
        }
        if (existsSync(path.join(PROJ, 'b.txt')) && conv && !(state.conversations ?? []).find((c) => c.id === conv.id)?.busy) {
          result.cenarios.continuouEtapa = true
          await sleep(5000)
          await shot(page, '04-continuou-etapa')
          break
        }
      }
      await sleep(2000)
    }
    result.conversa = conv ? { id: conv.id, title: conv.title } : null
    result.mensagensDoUsuario = conv ? (await userTexts(bridge, conv.id)).map((t) => t.slice(0, 600)) : []
  } catch (err) {
    log(`ERRO: ${err?.stack ?? err}`)
    result.erro = String(err?.message ?? err)
    await shot(page, 'zz-erro')
  } finally {
    await shutdown(app, DATA, { log }).catch(() => undefined)
  }
  // Diário inteiro e as cobranças que chegaram ao agente no transcript (additionalContext do hook).
  const rows = diary()
  writeFileSync(path.join(OUT, 'diario.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const tr = collectTranscripts(PROJ, BASE)
  writeFileSync(path.join(OUT, 'transcricao-cobrancas.md'), transcriptExcerpts(tr.dir))
  result.diario = rows.length
  writeFileSync(path.join(OUT, 'resultado.json'), JSON.stringify(result, null, 2))
  log(`fim: ${JSON.stringify(result.cenarios)}; dados em ${BASE}`)
}

/** Trechos do transcript com a cobrança (📋) e o corte: o tipo da linha, a hora e ~500 caracteres. */
function transcriptExcerpts(dir) {
  const out = ['# Cobranças do Scrum Master no transcript do agente', '']
  const walk = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.jsonl') ? [path.join(d, e.name)] : [])) : [])
  for (const file of walk(dir)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const i = line.indexOf('📋 Scrum Master')
      if (i < 0) continue
      let meta = {}
      try {
        const j = JSON.parse(line)
        meta = { type: j.type, ts: j.timestamp, attachment: j.attachment?.type, hook: j.attachment?.hookEvent ?? j.attachment?.hookName }
      } catch {
        /* linha parcial */
      }
      out.push(`## ${path.basename(file)} — ${JSON.stringify(meta)}`, '', '```', line.slice(Math.max(0, i - 120), i + 500).replace(/\\n/g, '\n'), '```', '')
    }
  }
  return out.join('\n')
}

await main()
