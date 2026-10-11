import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ScrumDecisao } from './scrumTypes'

/**
 * O DIÁRIO PERMANENTE do Scrum Master: uma linha JSON por decisão, em
 * `<userData>/scrum-decisions.log`.
 *
 * Diferente do diário do PO (po/poLog.ts), este NUNCA rotaciona nem apaga: ele é
 * a matéria-prima para melhorar o SM depois (e o "já disparou" de cada marco
 * relido ao abrir o app). Nada de texto do usuário: só o que o SM decidiu e o
 * que mandou ao agente.
 *
 * Gravar é best-effort e em fila: falha de disco é engolida aqui — o diário
 * nunca pode derrubar o SM nem o chat.
 */

export const SCRUM_LOG_FILE = 'scrum-decisions.log'
export const SCRUM_LOG_FILE_ENV = 'AGENT_CODE_SCRUM_LOG_FILE'

export type ScrumLogWriter = (decisao: ScrumDecisao) => void

export async function defaultScrumLogFile(): Promise<string | null> {
  const override = process.env[SCRUM_LOG_FILE_ENV]
  if (override) return override
  // Fora do Electron (testes, scripts) não há userData: não grava nada.
  if (!process.versions.electron) return null
  try {
    const { app } = await import('electron')
    return join(app.getPath('userData'), SCRUM_LOG_FILE)
  } catch {
    return null
  }
}

/** O gravador com a espera da fila: quem relê o diário (o painel) espera as escritas anteriores. */
export type ScrumLogFileWriter = ScrumLogWriter & { idle(): Promise<void> }

/** O gravador de produção: uma escrita por vez, sem rotação, nunca lança. */
export function createScrumLogWriter(file: () => Promise<string | null> = defaultScrumLogFile): ScrumLogFileWriter {
  let queue: Promise<void> = Promise.resolve()
  const write = (decisao: ScrumDecisao): void => {
    let line: string
    try {
      line = JSON.stringify(decisao)
    } catch {
      return
    }
    queue = queue
      .then(async () => {
        const target = await file()
        if (!target) return
        await mkdir(dirname(target), { recursive: true })
        await appendFile(target, `${line}\n`, 'utf8')
      })
      .catch(() => undefined)
  }
  return Object.assign(write, { idle: () => queue })
}

function isDecisao(value: unknown): value is ScrumDecisao {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.id === 'string' && typeof v.at === 'string' && typeof v.tipo === 'string' && typeof v.convId === 'string' && typeof v.envioId === 'string'
}

/** Lê as decisões de um texto do diário, pulando linha quebrada ou de outro formato. */
export function parseScrumLog(text: string): ScrumDecisao[] {
  const out: ScrumDecisao[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (isDecisao(value)) out.push(value)
    } catch {
      // Linha quebrada (gravação cortada no meio): segue para a próxima.
    }
  }
  return out
}

/** Lê o diário inteiro; arquivo ausente ou ilegível = nenhuma decisão. Nunca lança. */
export async function readScrumLog(file: () => Promise<string | null> = defaultScrumLogFile): Promise<ScrumDecisao[]> {
  return readScrumLogStrict(file).catch((): ScrumDecisao[] => [])
}

/** Como readScrumLog, mas o diário ilegível LANÇA (a aba Histórico mostra o erro); ausente = vazio. */
export async function readScrumLogStrict(file: () => Promise<string | null> = defaultScrumLogFile): Promise<ScrumDecisao[]> {
  const target = await file()
  if (!target) return []
  try {
    return parseScrumLog(await readFile(target, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw err
  }
}
