import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PoPhase } from './poPrompt'

/**
 * O diário do PO: uma linha JSON por rodada (abertura ou fechamento), em
 * `<userData>/po-decisions.log`. Existe porque, sem ele, gate "não", cooldown,
 * falha e "OK" do modelo eram indistinguíveis — o cartão simplesmente não
 * mudava e não havia como saber por quê.
 *
 * Mesma regra de segurança do digest: só identificadores e o resultado, NUNCA o
 * texto do usuário nem o conteúdo das ações. Arquivo local e não
 * `board_item_events`: sem schema novo e sem carga no PostgreSQL compartilhado.
 *
 * Gravar é best-effort: falha de disco (pasta sem permissão, disco cheio) é
 * engolida aqui — o diário nunca pode derrubar o PO nem o chat.
 */

export const PO_LOG_FILE = 'po-decisions.log'
const MAX_LOG_BYTES = 2 * 1024 * 1024

/** `ops=N`: N operações aplicadas. `ok`: a rodada chegou ao fim sem aplicar nada. */
export type PoLogOutcome = 'gate-nao' | 'cooldown' | 'desligado' | 'falha' | 'ok' | 'quadro-indisponivel' | `ops=${number}`

export interface PoLogEntry {
  at: string
  conversationId: string
  phase: PoPhase
  outcome: PoLogOutcome
  /** A rota de modelo que rodou; `null` quando nenhum modelo foi consultado. */
  route: 'claude' | 'gpt-luna' | null
  durationMs: number
  /** Ids dos cartões que a rodada escreveu (inclusive os criados). */
  cards: string[]
}

export type PoLogWriter = (entry: PoLogEntry) => void

export async function defaultPoLogFile(): Promise<string | null> {
  const override = process.env.AGENT_CODE_PO_LOG_FILE
  if (override) return override
  // Fora do Electron (testes, scripts) não há userData: não grava nada.
  if (!process.versions.electron) return null
  try {
    const { app } = await import('electron')
    return join(app.getPath('userData'), PO_LOG_FILE)
  } catch {
    return null
  }
}

async function writeLine(file: string, line: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const size = await stat(file).then((info) => info.size, () => 0)
  if (size > MAX_LOG_BYTES) await rename(file, `${file}.1`).catch(() => undefined)
  await appendFile(file, `${line}\n`, 'utf8')
}

/** O gravador de produção. As linhas saem em fila (uma escrita por vez), para
 *  duas rodadas simultâneas não disputarem a rotação do arquivo. */
export function createPoLogWriter(file: () => Promise<string | null> = defaultPoLogFile): PoLogWriter {
  let queue: Promise<void> = Promise.resolve()
  return (entry) => {
    const line = JSON.stringify(entry)
    queue = queue
      .then(async () => {
        const target = await file()
        if (target) await writeLine(target, line)
      })
      .catch(() => undefined)
  }
}
