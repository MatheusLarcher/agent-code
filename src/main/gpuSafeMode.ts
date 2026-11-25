/**
 * Modo seguro da GPU. Em alguns PCs o processo de GPU do Chromium não sobe
 * (driver ou sandbox recusado): ele cai em sequência e o Electron fecha o app
 * antes de abrir a janela — o usuário clica no atalho e nada acontece.
 *
 * Aqui: cada queda do processo de GPU logo na abertura sobe um nível, gravado
 * em `<userData>/gpu-modo.json` (gravação síncrona: o app pode morrer em
 * seguida). Na segunda queda o app reinicia já no nível novo. O nível vale nas
 * próximas aberturas:
 *   0 — normal;
 *   1 — `--disable-gpu-sandbox` (o que resolveu no PC que não abria);
 *   2 — sem aceleração de hardware (desenho por software, sempre funciona).
 *
 * `applyGpuMode` tem de rodar ANTES do `ready` (troca de chave do Chromium).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type GpuLevel = 0 | 1 | 2
export const MAX_GPU_LEVEL: GpuLevel = 2

export interface GpuModeState {
  level: GpuLevel
  /** Quando o nível atual foi gravado (ISO). */
  since?: string
  /** Motivo da última subida (tipo da queda). */
  reason?: string
}

export const GPU_MODE_FILE = 'gpu-modo.json'
/** Quedas dentro desta janela, contada da abertura, são "o app não abre". */
export const BOOT_WINDOW_MS = 90_000
/** Fora da abertura: quantas quedas em `LATE_WINDOW_MS` sobem o nível (vale na próxima abertura). */
export const LATE_CRASHES = 3
export const LATE_WINDOW_MS = 10 * 60_000

const IGNORED_REASONS = new Set(['clean-exit', 'killed'])

function asLevel(value: unknown): GpuLevel {
  return value === 1 || value === 2 ? value : 0
}

/** Estado gravado; arquivo ausente ou corrompido = normal. */
export function readGpuMode(dir: string): GpuModeState {
  try {
    const raw = JSON.parse(readFileSync(join(dir, GPU_MODE_FILE), 'utf8')) as Record<string, unknown>
    const state: GpuModeState = { level: asLevel(raw.level) }
    if (typeof raw.since === 'string') state.since = raw.since.slice(0, 40)
    if (typeof raw.reason === 'string') state.reason = raw.reason.slice(0, 80)
    return state
  } catch {
    return { level: 0 }
  }
}

export function writeGpuMode(dir: string, state: GpuModeState): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, GPU_MODE_FILE), `${JSON.stringify(state)}\n`, 'utf8')
  } catch (error) {
    console.warn('[gpu] não consegui gravar o modo seguro:', error)
  }
}

/** O que cada nível liga no Chromium. */
export function gpuSettingsFor(level: GpuLevel): { switches: string[]; disableHardware: boolean } {
  if (level >= 2) return { switches: ['disable-gpu-sandbox'], disableHardware: true }
  if (level === 1) return { switches: ['disable-gpu-sandbox'], disableHardware: false }
  return { switches: [], disableHardware: false }
}

/** Texto curto do nível, para o relatório de bug. */
export function describeGpuLevel(level: GpuLevel): string {
  if (level >= 2) return 'modo seguro 2 (sem aceleração de hardware)'
  if (level === 1) return 'modo seguro 1 (sem sandbox da GPU)'
  return 'normal'
}

export interface GpuApp {
  commandLine: { appendSwitch(name: string): void }
  disableHardwareAcceleration(): void
}

/** Lê o nível gravado e liga as chaves. Chamar antes do `ready`. */
export function applyGpuMode(app: GpuApp, dir: string): GpuModeState {
  const state = readGpuMode(dir)
  const settings = gpuSettingsFor(state.level)
  for (const name of settings.switches) app.commandLine.appendSwitch(name)
  if (settings.disableHardware) app.disableHardwareAcceleration()
  if (state.level > 0) console.warn(`[gpu] abrindo em ${describeGpuLevel(state.level)}`)
  return state
}

export interface GpuCrashWatchOptions {
  dir: string
  state: GpuModeState
  startedAt: number
  now?: () => number
  /** Reinicia o app (já no nível novo). Ausente = só grava para a próxima abertura. */
  relaunch?: () => void
}

/**
 * Decide o que fazer a cada queda de processo filho. Devolve o handler para
 * ligar em `app.on('child-process-gone', (_e, d) => handler(d))`.
 */
export function createGpuCrashHandler(options: GpuCrashWatchOptions): (details: { type: string; reason: string }) => void {
  const now = options.now ?? Date.now
  const state: GpuModeState = { ...options.state }
  let bootCrashes = 0
  let late: number[] = []
  let relaunched = false

  const escalate = (reason: string): boolean => {
    if (state.level >= MAX_GPU_LEVEL) return false
    state.level = (state.level + 1) as GpuLevel
    state.since = new Date(now()).toISOString()
    state.reason = reason
    writeGpuMode(options.dir, state)
    console.warn(`[gpu] processo de GPU caiu (${reason}): próximo início em ${describeGpuLevel(state.level)}`)
    return true
  }

  return (details) => {
    if (details?.type !== 'GPU' || IGNORED_REASONS.has(details.reason)) return
    const at = now()
    if (at - options.startedAt <= BOOT_WINDOW_MS) {
      bootCrashes += 1
      // 1ª queda: só grava (se o app morrer agora, a próxima abertura já vem segura).
      // 2ª: o Chromium está desistindo da GPU — reinicia no nível gravado.
      // Sem como reiniciar (ou nível no teto), a 3ª queda sobe mais um nível.
      if (bootCrashes === 1) escalate(details.reason)
      else if (!relaunched && options.relaunch && state.level > options.state.level) {
        relaunched = true
        options.relaunch()
      } else if (bootCrashes === 3 && !relaunched) escalate(details.reason)
      return
    }
    late = late.filter((t) => at - t < LATE_WINDOW_MS)
    late.push(at)
    if (late.length >= LATE_CRASHES) {
      late = []
      escalate(details.reason)
    }
  }
}
