/**
 * Detector de travadas da tela. Três sensores, um destino:
 *
 * - `quadro`: PerformanceObserver de long-animation-frame (só se o Chromium
 *   suportar; no jsdom é no-op) — quadro acima de FRAME_MS, com até 3 scripts.
 * - `trecho`: cronômetro dos trechos suspeitos (salvamento, celular,
 *   escritorio) — acima de SECTION_MS.
 * - `troca`: do clique até a próxima pintura (rAF → setTimeout 0) — acima de
 *   SWITCH_MS.
 *
 * Quadro que o LoAF entrega sem scripts (file:// é origem opaca) espera o
 * próximo envio e ganha a atribuição do JS Self-Profiling (jsProfiler.ts),
 * quando o ambiente o permite; sem ele, sai como está.
 *
 * Cada registro leva o contexto do momento, lido do provedor que o App
 * registra (refs, nunca closure velha) — só números e ids. Os registros saem em
 * lote para o main (`window.api.logFreezes`, que grava em travadas.log) a cada
 * BATCH_MS ou ao juntar BATCH_MAX. O custo do próprio detector tem de ser
 * desprezível: nada de serializar estado aqui.
 */
import type { FreezeContext, FreezeRecord, FreezeScript, FreezeSectionLabel, FreezeSwitchTarget } from '@shared/ipc'
import { attributeFrame, jsProfilerActive, rotateJsProfiler, scriptFileName, startJsProfiler, stopJsProfiler } from './jsProfiler'

export { scriptFileName }

export const FRAME_MS = 100
export const SECTION_MS = 50
export const SWITCH_MS = 150
export const BATCH_MS = 5000
export const BATCH_MAX = 20
const MAX_SCRIPTS = 3
const MAX_FUNCTION = 80

/** O contexto que o App fornece; `office` vem do OfficeTabHost (setOfficeMounted). */
export type FreezeContextProvider = () => Omit<FreezeContext, 'office'>

/** As partes do PerformanceLongAnimationFrameTiming que interessam (o DOM lib ainda não as tipa). */
interface LoafScript {
  invoker?: string
  invokerType?: string
  sourceFunctionName?: string
  sourceURL?: string
  sourceCharPosition?: number
  duration: number
}
interface LoafEntry {
  startTime: number
  duration: number
  blockingDuration?: number
  styleAndLayoutStart?: number
  scripts?: readonly LoafScript[]
}

type Entry = Omit<FreezeRecord, 'ctx'>

let provider: FreezeContextProvider | null = null
let officeMounted = false
let observer: PerformanceObserver | null = null
let pending: FreezeRecord[] = []
/** Quadros sem scripts do LoAF, esperando a atribuição do perfil no próximo envio. */
let awaiting: Array<{ record: FreezeRecord; start: number; end: number }> = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let switching = false

const now = (): number => performance.now()
const epoch = (perfMs: number): number => Math.round(performance.timeOrigin + perfMs)

function toScript(script: LoafScript): FreezeScript {
  const out: FreezeScript = { ms: Math.round(script.duration) }
  if (script.invoker) out.invoker = script.invoker.slice(0, 120)
  if (script.invokerType) out.invokerType = script.invokerType.slice(0, 120)
  if (script.sourceFunctionName) out.sourceFunctionName = script.sourceFunctionName.slice(0, MAX_FUNCTION)
  const file = scriptFileName(script.sourceURL)
  if (file) out.sourceFile = file.slice(0, 120)
  if (typeof script.sourceCharPosition === 'number' && script.sourceCharPosition >= 0) out.sourceCharPosition = script.sourceCharPosition
  return out
}

/** O registro de um quadro longo, ou null se ficou no limiar. */
export function frameEntry(entry: LoafEntry): Entry | null {
  if (!(entry.duration > FRAME_MS)) return null
  const scripts = [...(entry.scripts ?? [])]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, MAX_SCRIPTS)
    .map(toScript)
  const end = entry.startTime + entry.duration
  const layoutStart = entry.styleAndLayoutStart
  const layoutMs = typeof layoutStart === 'number' && layoutStart > 0 && layoutStart <= end ? Math.round(end - layoutStart) : undefined
  return {
    at: epoch(entry.startTime),
    kind: 'quadro',
    ms: Math.round(entry.duration),
    blockingMs: Math.round(entry.blockingDuration ?? 0),
    ...(layoutMs !== undefined ? { layoutMs } : {}),
    ...(scripts.length ? { scripts } : {})
  }
}

function context(): FreezeContext {
  try {
    return { ...(provider?.() ?? {}), office: officeMounted }
  } catch {
    return { office: officeMounted }
  }
}

function scheduleFlush(): void {
  if (!flushTimer) flushTimer = setTimeout(() => void flushTick(), BATCH_MS)
}

function record(entry: Entry): void {
  if (!provider) return
  pending.push({ ...entry, ctx: context() })
  if (pending.length >= BATCH_MAX) sendPending()
  else scheduleFlush()
}

/** Quadro longo: sem scripts do LoAF e com o perfil ligado, espera a atribuição. */
function recordFrame(entry: Entry, loaf: LoafEntry): void {
  if (!provider) return
  if (entry.scripts || !jsProfilerActive()) {
    record(entry)
    return
  }
  awaiting.push({ record: { ...entry, ctx: context() }, start: loaf.startTime, end: loaf.startTime + loaf.duration })
  scheduleFlush()
}

function sendPending(): void {
  if (!pending.length) return
  const batch = pending
  pending = []
  try {
    window.api?.logFreezes?.(batch)
  } catch {
    /* o detector nunca derruba a tela */
  }
}

/** O envio periódico: gira o perfil, atribui os quadros que esperam e manda. */
async function flushTick(): Promise<void> {
  flushTimer = null
  const frames = awaiting
  awaiting = []
  if (frames.length) {
    // Erro em qualquer passo: o quadro sai sem atribuição, nunca se perde.
    const traces = await rotateJsProfiler().catch(() => [])
    for (const frame of frames) {
      let found: ReturnType<typeof attributeFrame> = null
      try {
        found = traces.length ? attributeFrame(traces, frame.start, frame.end) : null
      } catch {
        found = null
      }
      pending.push(found ? { ...frame.record, jsMs: found.jsMs, ...(found.scripts.length ? { scripts: found.scripts } : {}) } : frame.record)
    }
  }
  sendPending()
}

/** Manda na hora o que estiver juntado (quadros à espera saem sem atribuição). Nunca lança. */
export function flushFreezes(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  for (const frame of awaiting) pending.push(frame.record)
  awaiting = []
  sendPending()
}

/** O Escritório 3D está montado (OfficeTabHost). */
export function setOfficeMounted(on: boolean): void {
  officeMounted = on
}

/** Início de um trecho cronometrado (performance.now()). */
export function freezeClock(): number {
  return now()
}

/** Fim de um trecho: registra se passou de SECTION_MS. */
export function freezeSection(
  label: FreezeSectionLabel,
  startedAt: number,
  extra?: { conversations?: number; mb?: number }
): void {
  const ms = now() - startedAt
  if (ms > SECTION_MS) record({ at: epoch(startedAt), kind: 'trecho', label, ms: Math.round(ms), ...extra })
}

/**
 * O tique do autosave: mede só a parte SÍNCRONA da chamada (limpeza e
 * comparação rodam antes do 1º await) e, se passou do limiar, registra quando a
 * Promise acaba, com quantas conversas e MB foram tratados. Devolve a MESMA
 * Promise — quem chama continua tratando o erro.
 */
export function timeSave<T extends { processed: number; bytes: number }>(run: () => Promise<T>): Promise<T> {
  const startedAt = now()
  const saving = run()
  const ms = now() - startedAt
  if (ms > SECTION_MS) {
    const base: Entry = { at: epoch(startedAt), kind: 'trecho', label: 'salvamento', ms: Math.round(ms) }
    saving.then(
      (stats) => record({ ...base, conversations: stats.processed, mb: stats.bytes / (1024 * 1024) }),
      () => record(base)
    )
  }
  return saving
}

const nextFrame = (cb: () => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => cb())
  else setTimeout(cb, 16)
}

/** Clique de troca: mede até a próxima pintura. Uma medição por vez (a 1ª vence). */
export function markSwitch(target: FreezeSwitchTarget): void {
  if (switching || !provider) return
  switching = true
  const startedAt = now()
  nextFrame(() =>
    setTimeout(() => {
      switching = false
      const ms = now() - startedAt
      // Janela escondida não pinta: o tempo medido seria o da ausência, não o da troca.
      if (ms > SWITCH_MS && document.visibilityState !== 'hidden') {
        record({ at: epoch(startedAt), kind: 'troca', target, ms: Math.round(ms) })
      }
    }, 0)
  )
}

/** Troca de conversa só se o destino for OUTRA (clicar na já aberta não é troca). */
export function markConversationSwitch(currentId: string | null, nextId: string): void {
  if (nextId !== currentId) markSwitch('conversa')
}

/** Troca de painel só se o painel muda ou estava recolhido (pedir o já visível não é troca). */
export function markPaneSwitch<P extends string>(current: P, minimized: boolean, next: P): void {
  if (minimized || next !== current) markSwitch('painel')
}

/** Liga o detector com o provedor de contexto do App. Devolve o desligar. */
export function startFreezeWatch(getContext: FreezeContextProvider): () => void {
  provider = getContext
  const types = typeof PerformanceObserver === 'function' ? (PerformanceObserver.supportedEntryTypes ?? []) : []
  if (!observer && types.includes('long-animation-frame')) {
    try {
      observer = new PerformanceObserver((list) => {
        for (const item of list.getEntries()) {
          const loaf = item as unknown as LoafEntry
          const entry = frameEntry(loaf)
          if (entry) recordFrame(entry, loaf)
        }
      })
      observer.observe({ type: 'long-animation-frame', buffered: true })
    } catch {
      observer = null
    }
  }
  if (observer) startJsProfiler()
  window.addEventListener('pagehide', flushFreezes)
  return () => {
    window.removeEventListener('pagehide', flushFreezes)
    observer?.disconnect()
    observer = null
    stopJsProfiler()
    flushFreezes()
    provider = null
    switching = false
  }
}
