import { READ_DEADLINE_MS as SHARED_READ_DEADLINE_MS, isReadDeadlineMessage, readDeadlineMessage } from '@shared/readDeadline'

/**
 * Prazos da tela para o que depende do banco: a interface nunca espera o banco
 * sem limite. As leituras de banco já vêm com prazo do preload
 * (shared/readDeadline.ts); estouradas, a tela mostra o que já tem e "tentar de
 * novo". O que só precisa terminar se der (salvar a UI ao fechar) para de esperar
 * no prazo.
 */

/** Prazo de uma leitura interativa (abrir conversa, painéis, históricos). */
export const READ_DEADLINE_MS = SHARED_READ_DEADLINE_MS

export class DeadlineError extends Error {
  constructor(message = readDeadlineMessage(READ_DEADLINE_MS)) {
    super(message)
    this.name = 'DeadlineError'
  }
}

/** O banco não respondeu no prazo (aqui ou no preload): vale "tentar de novo". */
export function isDeadlineError(error: unknown): boolean {
  return error instanceof DeadlineError || (error instanceof Error && isReadDeadlineMessage(error.message))
}

/** Texto curto para a tela: o prazo estourou, ou a falha como veio. */
export function readFailureText(error: unknown, fallback: string): string {
  if (isDeadlineError(error)) return 'O banco está demorando para responder.'
  return error instanceof Error && error.message ? error.message : fallback
}

/** A promessa, ou `DeadlineError` se ela não terminar em `ms`. */
export function withDeadline<T>(work: Promise<T>, ms = READ_DEADLINE_MS, message?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(message ?? readDeadlineMessage(ms))), ms)
  })
  return Promise.race([work, expired]).finally(() => clearTimeout(timer))
}

/** Espera `work` terminar (bem ou mal), mas no máximo `ms`. Nunca rejeita. */
export function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  return withDeadline(work, ms).then(
    () => undefined,
    () => undefined
  )
}
