/**
 * O chamado do agente no main: a sessão (handler da ferramenta app_chamar_usuario)
 * avisa por aqui; o index.ts liga quem avisa o Windows e a ponte do celular.
 *
 * O id do chamado é o id da chamada da ferramenta (o mesmo que o escritório lê
 * nas mensagens). O handler do MCP não o recebe, então o PreToolUse o anota
 * por arquivo (`CallIds`) e o handler o retira.
 */

/** Um chamado aceito pela ferramenta. */
export interface OfficeCallNotice {
  id: string
  convId: string
  cwd: string
  /** Caminho absoluto do HTML. */
  path: string
  mensagem: string | null
  at: number
}

let sink: ((notice: OfficeCallNotice) => void) | null = null

/** Quem recebe os chamados (o index.ts, no boot). */
export function setOfficeCallSink(fn: ((notice: OfficeCallNotice) => void) | null): void {
  sink = fn
}

export function emitOfficeCall(notice: OfficeCallNotice): void {
  try {
    sink?.(notice)
  } catch {
    /* o aviso falhou; o chamado segue nas mensagens da conversa */
  }
}

/** Anotação velha (a chamada foi negada antes do handler) não serve a outra chamada. */
const ID_TTL_MS = 60_000

/** Ids das chamadas em voo, por arquivo (como o modelo o passou). */
export class CallIds {
  private readonly byFile = new Map<string, Array<{ id: string; at: number }>>()

  constructor(private readonly clock: () => number = Date.now) {}

  /** PreToolUse: anota o id da chamada. */
  note(toolInput: unknown, id: string): void {
    const file = fileOf(toolInput)
    if (!file || !id) return
    const list = (this.byFile.get(file) ?? []).filter((e) => this.clock() - e.at < ID_TTL_MS)
    list.push({ id, at: this.clock() })
    this.byFile.set(file, list)
  }

  /** Handler: o id da chamada mais antiga deste arquivo; null se não há. */
  take(file: string): string | null {
    const list = (this.byFile.get(file.trim()) ?? []).filter((e) => this.clock() - e.at < ID_TTL_MS)
    const first = list.shift()
    if (list.length) this.byFile.set(file.trim(), list)
    else this.byFile.delete(file.trim())
    return first?.id ?? null
  }
}

function fileOf(input: unknown): string | null {
  const v = input && typeof input === 'object' ? (input as Record<string, unknown>).arquivo : null
  return typeof v === 'string' && v.trim() ? v.trim() : null
}
