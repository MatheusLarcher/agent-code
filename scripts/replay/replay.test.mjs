// Teste mínimo do arnês do replay. Rodar: node --test scripts/replay/replay.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { endsWithQuestion, lastAssistantOf, markDelivered, nextPromptIndex, pendingBackgroundIn, userTexts } from './drive.mjs'
import { codePass, newFailures } from './evaluate.mjs'
import { ruleCase, writeFence } from './fence.mjs'
import { isolatedEnv } from './instance.mjs'
import { claudeProjectSlug, parseFirstEdit } from './measure.mjs'
import { absolutePaths, decidePermission, insideAny, recommendedAnswers } from './policy.mjs'
import { outOf, paths, referenceSpecOf, ROUNDS, roundTimeoutOf, sidesOf } from './config.mjs'
import { autonomyVerdict, eventCounts, roundRow, taskVerdict, wallProjection } from './report.mjs'
import { drawLabels, reviewPair } from './review.mjs'
import { attentionKinds, sessionCounters } from './baseline-sessao.mjs'
import * as replay from './replay.mjs'
import { diffStats } from './worktree.mjs'

const WT = 'D:\\agent-code-replay\\t2\\agent-code'
const RUN = 'D:\\agent-code-replay\\runs\\t2-hoje-r1'
const ctx = {
  worktree: WT,
  writable: [`${RUN}\\perfil`, `${RUN}\\agent-code`],
  protectedPaths: ['C:/GitHub/agent-code', 'C:\\Users\\mathe\\AppData\\Roaming\\agent-code-desktop'],
  forbidden: ['C:\\GitHub\\agent-code', 'D:\\agent-code-replay\\t1', 'D:\\agent-code-replay\\saidas', 'D:\\OneDrive', `${RUN}\\userData`, 'C:\\Users\\mathe\\AppData\\Local\\agent-code']
}
const decide = (toolName, input) => decidePermission({ toolName, input }, ctx).behavior

test('escrita só dentro da rodada; a cerca (.claude da cópia) é do arnês', () => {
  assert.equal(decide('Edit', { file_path: `${WT}\\src\\main\\po\\po.ts` }), 'allow')
  assert.equal(decide('Write', { file_path: `${RUN}/agent-code/memories/x.md` }), 'allow')
  assert.equal(decide('Edit', { file_path: 'C:\\GitHub\\agent-code\\src\\main\\po\\po.ts' }), 'deny')
  assert.equal(decide('Write', { file_path: `${RUN}\\userData\\x.json` }), 'deny')
  assert.equal(decide('Write', { file_path: `${WT}\\.claude\\settings.local.json` }), 'deny')
  assert.equal(decide('Bash', { command: 'rm .claude/settings.local.json' }), 'deny')
  assert.equal(decide('Write', {}), 'deny')
})

test('shell: o que sai da rodada é negado', () => {
  assert.equal(decide('Bash', { command: 'npm run typecheck && npx vitest run src/main/po' }), 'allow')
  assert.equal(decide('Bash', { command: 'git status && git diff && git log --oneline -5' }), 'allow')
  assert.equal(decide('Bash', { command: 'git add -A && git commit -m "feat: x"' }), 'allow')
  assert.equal(decide('Bash', { command: "grep -rn \"from 'electron'\" src | head" }), 'allow')
  assert.equal(decide('Bash', { command: 'npm run build' }), 'allow')
  for (const bad of [
    'git push origin main',
    'git clone https://github.com/MatheusLarcher/agent-code.git /tmp/x',
    'git fetch https://github.com/x/y main',
    'curl -s https://raw.githubusercontent.com/x/y/main/src/a.ts',
    'gh api repos/x/y',
    'npm run dev',
    'node_modules/.bin/electron.cmd .',
    'npx electron .',
    'Start-Process "node_modules\\electron\\dist\\electron.exe" -ArgumentList .',
    'taskkill /IM electron.exe /F',
    '(Get-Process electron).Kill()',
    'npm install lodash',
    'rm -rf C:/GitHub/agent-code/out',
    'cd C:/GitHub/agent-code && npm test',
    'git -C C:/GitHub/agent-code log -5',
    '[Environment]::GetFolderPath("ApplicationData")'
  ]) assert.equal(decide('Bash', { command: bad }), 'deny', bad)
})

test('cerca de leitura: pastas proibidas, as de cima delas e subir dois níveis', () => {
  assert.equal(decide('Bash', { command: 'cat C:/GitHub/agent-code/src/main/po/poApply.ts' }), 'deny')
  assert.equal(decide('Bash', { command: 'ls D:\\agent-code-replay\\t1\\agent-code\\src' }), 'deny')
  assert.equal(decide('Bash', { command: 'rg poApply D:/agent-code-replay' }), 'deny')
  assert.equal(decide('Bash', { command: 'ls /d/' }), 'deny')
  assert.equal(decide('PowerShell', { command: 'Get-ChildItem D:\\OneDrive\\Documentos' }), 'deny')
  assert.equal(decide('Bash', { command: 'ls ../../' }), 'deny')
  assert.equal(decide('Bash', { command: 'cd ..; cd ..; ls' }), 'deny')
  assert.equal(decide('Bash', { command: 'ls ..' }), 'allow')
  assert.equal(decide('Read', { file_path: 'D:\\agent-code-replay\\saidas\\t2\\novo-r1\\diff.patch' }), 'deny')
  assert.equal(decide('Bash', { command: 'Get-Content C:\\Users\\mathe\\AppData\\Local\\agent-code\\postgres.log' }), 'deny')
  assert.equal(decide('Read', { file_path: `${WT}\\src\\main\\po\\po.ts` }), 'allow')
  assert.equal(decide('Bash', { command: 'echo "pt-BR: ok"' }), 'allow')
})

test('ferramentas que controlam o PC, a rede ou fogem do diff são negadas', () => {
  for (const t of ['mcp__windows__windows_click', 'mcp__chrome__chrome_navigate', 'mcp__browser__browser_navigate', 'mcp__app__app_restart', 'WebFetch', 'WebSearch', 'EnterWorktree']) assert.equal(decide(t, {}), 'deny', t)
  assert.equal(decide('Agent', { isolation: 'worktree', prompt: 'x' }), 'deny')
  assert.equal(decide('Agent', { prompt: 'x' }), 'allow')
})

test('caminhos: dentro/fora e extração do comando', () => {
  assert.equal(insideAny('D:/agent-code-replay/t2/agent-code/src', [WT]), true)
  assert.equal(insideAny('D:/agent-code-replay/t2/agent-codex', [WT]), false)
  assert.deepEqual(absolutePaths('cd /c/GitHub/agent-code && ls "D:\\x y"').map((p) => p.toLowerCase()).sort(), ['c:\\github\\agent-code', 'd:\\x'])
  assert.deepEqual(absolutePaths('echo pt-BR: ok'), [])
})

test('cerca do CLI: regras de leitura na forma POSIX e ferramentas negadas', () => {
  assert.equal(ruleCase('C:\\GitHub\\agent-code'), '//c/GitHub/agent-code')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'replay-cerca-'))
  try {
    const deny = writeFence(dir, ['C:\\GitHub\\agent-code'])
    assert.ok(deny.includes('Read(//c/GitHub/agent-code/**)'))
    for (const t of ['WebFetch', 'WebSearch', 'mcp__browser', 'EnterWorktree']) assert.ok(deny.includes(t))
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8')).permissions.deny, deny)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pergunta: só o rótulo com "(Recomendado)"; "Não recomendado" nunca', () => {
  const q = [
    { header: 'A', question: 'qual?', multiSelect: false, options: [{ label: 'X', description: 'Não recomendado: quebra' }, { label: 'Y (Recomendado)', description: '' }] },
    { header: 'B', question: 'e?', multiSelect: false, options: [{ label: 'P', description: 'recomendado por alguns' }, { label: 'Q', description: '' }] }
  ]
  assert.deepEqual(recommendedAnswers(q).map((a) => a.selected), [['Y (Recomendado)'], ['P']])
})

test('segundo plano sem notificação de volta é trabalho em andamento, não fim', () => {
  const started = 'tool_result: Command running in background with ID: b054psicr. Output is being written'
  assert.equal(pendingBackgroundIn([started]), 1)
  assert.equal(pendingBackgroundIn([started, '<task-notification>\n<task-id>b054psicr</task-id>\n<status>completed</status>']), 0)
  assert.equal(pendingBackgroundIn([started, 'running in background with ID: bx2'], ), 2)
  assert.equal(pendingBackgroundIn(['nada em segundo plano']), 0)
})

test('mensagens da ponte: assistant-text e pergunta seguida de lista', () => {
  const msgs = [{ kind: 'user', text: '[ctx] # Handoff X\nfaça' }, { kind: 'assistant-text', text: 'Feito.\n\nQuer A ou B?\n- A: rápido\n- B: completo', final: true }]
  assert.equal(lastAssistantOf(msgs), 'Feito.\n\nQuer A ou B?\n- A: rápido\n- B: completo')
  assert.equal(endsWithQuestion(lastAssistantOf(msgs)), true)
  assert.equal(endsWithQuestion('Feito. Testes verdes.'), false)
  assert.deepEqual(userTexts(msgs), ['[ctx] # Handoff X\nfaça'])
})

test('prompt entregue continua entregue quando sai da janela de 30 mensagens da ponte', () => {
  const prompts = ['# Handoff 1\nfaça A', '# Handoff 2\nfaça B']
  const delivered = new Set()
  markDelivered(prompts, delivered, ['[ctx] # Handoff 1\nfaça A'])
  assert.equal(nextPromptIndex(prompts, delivered), 1)
  // Mais tarde a janela já não tem o prompt 1: não volta a ser "pendente".
  markDelivered(prompts, delivered, ['continue'])
  assert.equal(nextPromptIndex(prompts, delivered), 1)
  delivered.add(1)
  assert.equal(nextPromptIndex(prompts, delivered), -1)
})

test('avaliador de código: falha nova e falha de referência por nome', () => {
  const ev = { corePass: true, reference: { crashed: false, failed: [{ id: 'a' }, { id: 'b' }] } }
  assert.equal(codePass(ev, { a: 'nome', b: 'nome' }), true)
  assert.equal(codePass(ev, { a: 'nome', b: 'comportamento' }), false)
  assert.equal(codePass({ ...ev, corePass: false }, { a: 'nome', b: 'nome' }), false)
  assert.deepEqual(newFailures({ failed: [{ id: 'x' }, { id: 'y' }] }, ['x']).map((f) => f.id), ['y'])
})

test('handoff desconta o orçamento sem conceder mínimo extra à implementação', () => {
  // Reintroduzir Math.max(60_000, restante) quebra estas bordas.
  assert.equal(replay.remainingRoundMs(600_000, 1000, 601_000), 0, 'teto atingido')
  assert.equal(replay.remainingRoundMs(600_000, 1000, 611_000), 0, 'handoff excedeu teto')
  assert.equal(replay.remainingRoundMs(600_000, 1000, 600_500), 500, 'só 500 ms restantes')
  assert.equal(replay.remainingRoundMs(600_000, 1000, 301_000), 300_000)
})

test('rodada: timeout reprova mesmo verde; done aprova; estado faltante reprova', () => {
  // Remover a exigência de status done faria timeout/estado faltante passarem.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'replay-tempo-'))
  const original = { out: paths.out, reviewResult: paths.reviewResult }
  const runFile = path.join(dir, 'run.json')
  try {
    paths.out = () => dir
    paths.reviewResult = () => path.join(dir, 'review.json')
    writeFileSync(path.join(dir, 'eval.json'), JSON.stringify({
      corePass: true, typecheck: { ok: true }, suite: { newFailures: [] },
      reference: { crashed: false, failed: [], passed: 1, total: 1 }
    }))
    const check = (run, expected, label) => {
      if (run === null) rmSync(runFile, { force: true })
      else writeFileSync(runFile, JSON.stringify(run))
      assert.equal(roundRow('fixture', 'novo', 1).code, expected, label)
    }
    check({ implementation: { status: 'timeout' } }, false, 'timeout + verde')
    check({ implementation: { status: 'done' } }, true, 'done + verde')
    check({}, false, 'implementation faltante')
    check({ implementation: {} }, false, 'status faltante')
    check(null, false, 'run faltante')
    check({ implementation: { status: 'done' }, error: 'infra' }, false, 'erro não aprova')
  } finally {
    Object.assign(paths, original)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('aprovação: pass^k do novo, nenhuma nota média pior e dados completos', () => {
  const notas = (v) => ({ atende: v, bugs: v, bordas: v, regras: v })
  const rounds = Array.from({ length: ROUNDS }, (_, i) => i + 1)
  const rows = (novoCode, novoNota, reviewed = true) => [
    ...rounds.map((n) => ({ side: 'hoje', n, exists: true, reviewed, code: true, notas: notas(4) })),
    ...rounds.map((n) => ({ side: 'novo', n, exists: true, reviewed, code: novoCode[n - 1], notas: notas(novoNota) }))
  ]
  const all = rounds.map(() => true)
  assert.equal(taskVerdict(rows(all, 4)).approved, true)
  assert.equal(taskVerdict(rows(all, 5)).approved, true)
  assert.equal(taskVerdict(rows(rounds.map((n) => n !== 2), 5)).approved, false)
  const worse = taskVerdict(rows(all, 3.9))
  assert.equal(worse.approved, false)
  assert.match(worse.reasons.join(' '), /atende/)
  const partial = taskVerdict(rows(all, 5, false))
  assert.equal(partial.approved, false)
  assert.equal(partial.incomplete, true)
})

test('sorteio A/B devolve os dois lados', () => {
  assert.deepEqual(drawLabels(() => 0), { A: 'hoje', B: 'novo' })
  assert.deepEqual(drawLabels(() => 1), { A: 'novo', B: 'hoje' })
  // Lado único (a1): o lado × a referência, às cegas.
  assert.deepEqual(reviewPair('a1'), ['novo', 'referencia'])
  assert.deepEqual(reviewPair('s1'), ['hoje', 'novo'])
  assert.deepEqual(drawLabels(() => 1, reviewPair('a1')), { A: 'referencia', B: 'novo' })
})

test('a1: teto de 60 min, lado único, referência em faixa e saída própria; s1–s3 inalteradas', () => {
  assert.equal(roundTimeoutOf('a1'), 60 * 60_000)
  assert.equal(roundTimeoutOf('s1'), 10 * 60_000)
  assert.deepEqual(Object.keys(sidesOf('a1')), ['novo'])
  assert.deepEqual(Object.keys(sidesOf('s2')), ['hoje', 'novo'])
  assert.equal(referenceSpecOf('a1'), '8c89585..526d549')
  assert.equal(referenceSpecOf('s3'), '974d348')
  assert.match(outOf('a1'), /replay-autonomia-2026-10-10$/)
  assert.match(paths.published('a1', 'novo', 1), /replay-autonomia-2026-10-10[\\/]a1[\\/]novo-r1$/)
})

/** Transcript sintético: user com carimbo abre turno; assistant com usage, texto e ferramentas. */
const stamp = (text) => `[Contexto do sistema: mensagem enviada do PC X em 06/10/2026.]\n\n[SKILL_CATALOG_UPDATE]x[/SKILL_CATALOG_UPDATE]\n${text}`
const at = (min) => new Date(Date.UTC(2026, 9, 6, 14, 0) + min * 60_000).toISOString()
const user = (min, text) => ({ type: 'user', timestamp: at(min), message: { content: stamp(text) } })
const result = (min, text) => ({ type: 'user', timestamp: at(min), message: { content: [{ type: 'tool_result', tool_use_id: 't', content: text }] } })
const asst = (min, id, content, input = 100) => ({ type: 'assistant', timestamp: at(min), message: { id, usage: { input_tokens: input, cache_read_input_tokens: 0 }, content } })

test('contadores da sessão base: perguntas, 7 min, turnos em pergunta, prompts atrasados, tempo, chamadas, contexto e avisos', () => {
  const main = [
    user(0, '# Implementação 1/2 — X\nfaça'),
    asst(1, 'm1', [{ type: 'text', text: 'ATENÇÃO: outra conversa mexeu em a.ts' }, { type: 'tool_use', name: 'AskUserQuestion', input: {} }], 200),
    result(8, 'O usuário não respondeu em 7 minutos. Siga sem a resposta dele.'),
    asst(9, 'm2', [{ type: 'text', text: 'Feito.\n\nQuer que eu siga com B?' }], 400),
    user(30, '# Implementação 2/2 — Y\nfaça'),
    asst(31, 'm3', [{ type: 'text', text: '- DESVIO DO PLANO: usei Z\nPronto, testes verdes.' }], 600),
    user(32, 'ele disse ATENÇÃO: x?'),
    asst(33, 'm4', [{ type: 'text', text: 'ele disse ATENÇÃO: nada' }], 800)
  ]
  const sub = [asst(10, 's1', [{ type: 'text', text: 'ok' }], 1000)]
  const c = sessionCounters(main, [sub])
  assert.equal(c.turns, 3)
  assert.equal(c.handoffPrompts, 2)
  assert.equal(c.lateHandoffPrompts, 1, 'o prompt 2 chegou 21 min depois do fim do turno anterior')
  assert.equal(c.askUserQuestion, 1)
  assert.equal(c.expired7min, 1)
  assert.equal(c.turnsEndingInQuestion, 1)
  assert.equal(c.activeSecs, (9 + 1 + 1) * 60)
  assert.equal(c.wallSecs, 33 * 60)
  assert.equal(c.calls, 5)
  assert.equal(c.avgContextTokens, Math.round((200 + 400 + 600 + 800 + 1000) / 5))
  assert.equal(c.atencaoLines, 1, 'citação no meio da linha não conta')
  assert.equal(c.desvioLines, 1)
  assert.deepEqual(attentionKinds('**ATENÇÃO:** a\n> DESVIO DO PLANO: b\nnada ATENÇÃO: c'), { atencao: 1, desvio: 1 })
})

test('validação da autonomia: eventos, veredito por meta e projeção de parede', () => {
  assert.deepEqual(eventCounts([{ kind: 'pergunta' }, { kind: 'allow' }, { kind: 'insistencia' }, { kind: 'insistencia' }]), {
    pergunta: 1, insistencia: 2, 'proximo-prompt': 0, 'primeiro-prompt-forcado': 0
  })
  const base = { askUserQuestion: 1, expired7min: 1, turnsEndingInQuestion: 2, lateHandoffPrompts: 0, activeSecs: 6000, calls: 280, avgContextTokens: 400_000, atencaoLines: 0, desvioLines: 0 }
  const notas = (v) => ({ atende: v, bugs: v, bordas: v, regras: v })
  const row = (n, over = {}) => ({
    t: 'a1', side: 'novo', n, exists: true, status: 'done', error: null,
    events: eventCounts([]), activeSecs: 3000, calls: 150, avgContextTokens: 150_000, askUserQuestion: 0, turnsEndingInQuestion: 0,
    atencao: 2, desvio: 0, typecheck: true, newFailures: 0, missing: 0, ref: '5/5', refOk: true,
    review: { novo: notas(4), referencia: notas(4) }, ...over
  })
  assert.equal(autonomyVerdict(base, [row(1), row(2)]).approved, true)
  const asked = autonomyVerdict(base, [row(1), row(2, { events: eventCounts([{ kind: 'pergunta' }]) })])
  assert.equal(asked.approved, false)
  assert.deepEqual(asked.failed, ['pergunta'])
  const slower = autonomyVerdict(base, [row(1, { activeSecs: 6001 }), row(2)])
  assert.deepEqual(slower.failed, ['tempo-ativo'])
  const worseReview = autonomyVerdict(base, [row(1, { review: { novo: notas(3), referencia: notas(4) } }), row(2)])
  assert.deepEqual(worseReview.failed, ['revisao'])
  const timedOut = autonomyVerdict(base, [row(1, { status: 'timeout' }), row(2)])
  assert.deepEqual(timedOut.failed, ['concluiu'])
  const missingRound = autonomyVerdict(base, [row(1), { ...row(2), exists: false }])
  assert.equal(missingRound.approved, false)
  assert.equal(missingRound.incomplete, true)
  assert.deepEqual(wallProjection(base, [row(1), row(2)]), { turnsSaved: 2, minutesSaved: 28, basis: '14 min de parada média por turno que perguntava (medição de 09/10)' })
})

test('diff, slug do projeto, medição e ambiente isolado', () => {
  assert.deepEqual(diffStats('3\t1\tsrc/a.ts\n10\t0\tsrc/a.test.ts\n-\t-\timg.png\n'), { files: 3, add: 13, del: 1, tests: ['src/a.test.ts'] })
  assert.equal(claudeProjectSlug(WT), 'D--agent-code-replay-t2-agent-code')
  assert.deepEqual(parseFirstEdit('handoff: 1 pedidos | p50 248s, 13 chamadas, 9 Read, 7 arquivos'), { pedidos: 1, secsToFirstEdit: 248, callsToFirstEdit: 13, readsToFirstEdit: 9 })
  const env = isolatedEnv('D:\\dados', { PATH: 'x', CLAUDE_CONFIG_DIR: 'y', ANTHROPIC_API_KEY: 'z', USERPROFILE: 'C:\\Users\\u', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })
  assert.equal(env.CLAUDE_CONFIG_DIR, 'C:\\Users\\u\\.claude')
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.USERPROFILE, 'D:\\dados\\perfil')
  assert.equal(env.APPDATA, 'D:\\dados\\perfil\\AppData\\Roaming')
  assert.equal(env.TEMP, 'D:\\dados\\perfil\\AppData\\Local\\Temp')
  assert.equal(env.AGENT_CODE_DEV_DATA_DIR, 'D:\\dados')
  assert.equal(env.VITEST_MAX_WORKERS, '4')
})
