/**
 * O `app_anexar_print` no main: a sessão do agente (handler da ferramenta)
 * chama por aqui; o index.ts liga quem valida, comprime e grava (printAttach.ts).
 * Sem quem receba (banco fora do ar no boot), a ferramenta recusa com motivo.
 */
import type { AttachPrintInput, AttachPrintResult } from './printAttach'

let sink: ((input: AttachPrintInput) => Promise<AttachPrintResult>) | null = null

export function setPrintSink(fn: ((input: AttachPrintInput) => Promise<AttachPrintResult>) | null): void {
  sink = fn
}

export async function attachPrintFromAgent(input: AttachPrintInput): Promise<AttachPrintResult> {
  if (!sink) return { ok: false, message: 'Recusado: o quadro não está disponível nesta sessão' }
  try {
    return await sink(input)
  } catch (err) {
    return { ok: false, message: `Recusado: ${err instanceof Error ? err.message : String(err)}` }
  }
}
