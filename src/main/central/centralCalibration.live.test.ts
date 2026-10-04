// @vitest-environment node
/**
 * Calibração da Central (Etapa 8) com o histórico REAL — desligada por padrão.
 * Só roda com CENTRAL_CALIBRATION=1, a chave do TypeSafe em TYPESAFE_API_KEY
 * (só na linha de comando da rodada, nunca em arquivo) e a pasta de saída em
 * CENTRAL_CALIBRATION_OUT (fora do git). Só leitura: a exportação parquet
 * diária. Nenhuma mensagem vai para agente; nada é gravado no banco; o `state`
 * e as respostas do TypeSafe nunca vão ao console.
 *
 * Fase A (CENTRAL_CALIBRATION_PHASE=A, o padrão): gabarito automático e as
 * candidatas a aleatórias (`calibration-candidates.md`). PARA aí — a medição
 * (fase B) só depois de o usuário confirmar a lista.
 *
 * Opcionais: CENTRAL_CALIBRATION_PARQUET (fixa a exportação; padrão a mais nova),
 * CENTRAL_CALIBRATION_DATA_DIR (padrão %APPDATA%/agent-code-desktop/agent-code-local),
 * CENTRAL_CALIBRATION_LANG (en|pt), CENTRAL_CALIBRATION_BUDGET, CENTRAL_CALIBRATION_CONCURRENCY
 * e CENTRAL_CALIBRATION_DRY=1 (monta tudo e não chama o TypeSafe nem grava saída).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CentralRule } from '../../shared/central'
import { buildHistory, isInsideSandbox, newestExport, readExport } from './calibration/history'
import { createMemoAsk, typeSafeCall, type MemoAskStats } from './calibration/memoAsk'
import {
  PHASE_A_BUDGET,
  candidatesMarkdown,
  phaseACandidates,
  phaseASelection,
  scanFirstCalls,
  type ScanStatus
} from './calibration/phaseA'
import { createReplay } from './calibration/replay'
import type { AskFn } from './centralDecider'
import { estimateTokens } from './centralIndex'
import { CENTRAL_PROMPT_LANG, NO_PROJECT, type CentralPromptLang } from './centralPrompts'

const env = (name: string): string => process.env[name]?.trim() ?? ''
const enabled = env('CENTRAL_CALIBRATION') === '1'
const phase = (env('CENTRAL_CALIBRATION_PHASE') || 'A').toUpperCase()
const NO_CALLS: MemoAskStats = { network: 0, ok: 0, failed: 0, hits: 0, failures: {}, inputTokens: 0, outputTokens: 0 }

describe.runIf(enabled)('calibração da Central com o histórico real', () => {
  it.runIf(phase === 'A')(
    'fase A: gabarito automático e candidatas a aleatórias',
    async () => {
      const out = env('CENTRAL_CALIBRATION_OUT')
      if (!out) throw new Error('CENTRAL_CALIBRATION_OUT não definido')
      const dry = env('CENTRAL_CALIBRATION_DRY') === '1'
      const apiKey = env('TYPESAFE_API_KEY')
      if (!dry && !apiKey) throw new Error('TYPESAFE_API_KEY não definido')
      const dataDir = env('CENTRAL_CALIBRATION_DATA_DIR') || join(env('APPDATA'), 'agent-code-desktop', 'agent-code-local')
      const file = env('CENTRAL_CALIBRATION_PARQUET') || newestExport(dataDir)
      if (!file || !existsSync(file)) throw new Error('exportação parquet não encontrada')
      const langEnv = env('CENTRAL_CALIBRATION_LANG') || CENTRAL_PROMPT_LANG
      if (langEnv !== 'en' && langEnv !== 'pt') throw new Error('CENTRAL_CALIBRATION_LANG deve ser en ou pt')
      const lang: CentralPromptLang = langEnv
      const budget = Number(env('CENTRAL_CALIBRATION_BUDGET') || PHASE_A_BUDGET)
      const concurrency = Number(env('CENTRAL_CALIBRATION_CONCURRENCY') || 4)

      const sandboxRoot = join(dataDir, 'sandbox')
      const folders = new Map<string, boolean>()
      const exists = (path: string): boolean => {
        let ok = folders.get(path)
        if (ok === undefined) folders.set(path, (ok = existsSync(path)))
        return ok
      }
      const isSandbox = (cwd: string): boolean => isInsideSandbox(sandboxRoot, cwd)

      const history = buildHistory(await readExport(file), { exists, isSandbox })
      const replay = createReplay(history, { sandboxRoot, exists, isSandbox })
      const gold: Record<CentralRule, number> = { continua: 0, 'conversa-antiga': 0, nova: 0, sandbox: 0 }
      for (const request of history.requests) gold[replay.gold(request).rule]++
      const selection = phaseASelection(history, budget)

      // Conferência do replay (só números): nada do futuro no índice nem nos recentes; a conversa certa já existe nele.
      const replayCheck = { leaks: 0, ownInIndex: 0, recents: 0, projects: 0 }
      const createdAt = new Map(history.conversations.map((conv) => [conv.id, conv.createdAt]))
      for (const request of selection) {
        const { index, recent } = replay.at(request)
        const futureSummary = [...index.byId.values()].some(
          (s) => !(s.updatedAt < request.t) || !((createdAt.get(s.convId) ?? Number.POSITIVE_INFINITY) < request.t)
        )
        const futureRecent = recent.some((x) => !history.requests.some((r) => r.convId === x.convId && r.t < request.t))
        if (futureSummary || futureRecent) replayCheck.leaks++
        if (index.byId.has(request.convId)) replayCheck.ownInIndex++
        replayCheck.recents += recent.length
        replayCheck.projects += index.projects.filter((p) => !p.sandbox).length
      }

      // Seco: monta cada 1ª chamada e não pergunta nada (conta pedidos e o tamanho estimado).
      const dryRun = { built: 0, tokens: 0 }
      const dryAsk: AskFn = async (request) => {
        dryRun.built++
        dryRun.tokens += estimateTokens(JSON.stringify(request))
        return null
      }
      const memo = dry ? null : createMemoAsk(typeSafeCall(apiKey), join(out, 'calibration-cache.jsonl'))
      console.log(`[calibração] fase A: ${selection.length} mensagens; respostas já no cache: ${memo?.size() ?? 0}`)

      const started = Date.now()
      const scanned = await scanFirstCalls(selection, history, replay, memo?.ask ?? dryAsk, {
        lang,
        concurrency,
        exists,
        isSandbox,
        onProgress: (done, total) => {
          if (done % 100 === 0 || done === total) {
            console.log(`[calibração] ${done}/${total} (${Math.round((Date.now() - started) / 1000)} s)`)
          }
        }
      })
      const status: Record<ScanStatus, number> = { ok: 0, failed: 0, 'no-question': 0 }
      const choices = { noProject: 0, ownProject: 0, otherProject: 0 }
      for (const s of scanned) {
        status[s.status]++
        if (s.status !== 'ok') continue
        if (s.choice === NO_PROJECT) choices.noProject++
        else if (s.choice === s.ownOption) choices.ownProject++
        else choices.otherProject++
      }
      const candidates = phaseACandidates(scanned)
      const calls = memo?.stats() ?? NO_CALLS
      const summary = {
        phase: 'A',
        export: basename(file),
        generatedAt: new Date().toISOString(),
        lang,
        budget,
        concurrency,
        history: history.stats,
        gold,
        selection: selection.length,
        replayCheck,
        status,
        choices,
        calls,
        cacheEntries: memo?.size() ?? 0,
        candidates: candidates.map((c, i) => ({
          n: i + 1,
          convId: c.request.convId,
          messageId: c.request.id,
          t: c.request.t,
          interpolated: c.request.interpolated,
          goldRule: c.gold.rule,
          pNoProject: c.pNoProject ?? 0,
          pOwnProject: c.pOwnProject ?? null
        }))
      }
      if (dry) {
        console.log(`[calibração] seco: ${JSON.stringify({ ...summary, candidates: undefined, dryRun })}`)
      } else {
        mkdirSync(out, { recursive: true })
        const header = { exportName: summary.export, lang, budget, scanned: scanned.length, status, calls, generatedAt: new Date() }
        writeFileSync(join(out, 'calibration-candidates.md'), candidatesMarkdown(candidates, header), 'utf8')
        writeFileSync(join(out, 'calibration-phase-a.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
      }
      console.log(
        `[calibração] fase A: ${scanned.length} mensagens escaneadas, ${candidates.length} candidatas; chamadas ao ` +
          `TypeSafe feitas: ${calls.network} (ok ${calls.ok}, falhas ${calls.failed} ${JSON.stringify(calls.failures)}, ` +
          `do cache ${calls.hits})`
      )
      // Só números nas asserções: uma falha não pode imprimir conteúdo do histórico.
      expect(replayCheck.leaks).toBe(0)
      expect(scanned.length).toBe(selection.length)
    },
    4 * 60 * 60_000
  )
})
