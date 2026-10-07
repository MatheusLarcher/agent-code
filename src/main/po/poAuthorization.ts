import type { PoAuthorization, PoAuthorizationMap } from '../../shared/poAuthorization'

/**
 * A AUTORIZAÇÃO DO PO para commit e push, do lado do main:
 * - nasce na ABERTURA: o PO reconhece a frase do usuário e responde
 *   `AUTORIZAR | commit|commit+push | fila|sempre`; morre com `REVOGAR`, com o
 *   chip ou, no alcance "desta fila", quando a fila esvazia;
 * - no FECHAMENTO, a pendência de commit/push vira ITEM DE ROTINA na fila, com
 *   o texto FIXO montado aqui. Só o título do cartão concluído entra no texto;
 *   nada que o modelo escreva vira instrução ao agente.
 * - na dúvida, não autoriza: "commita isso" de uma vez só é pedido normal.
 */

export type PoAuthorizationOp = { kind: 'autorizar'; push: boolean; scope: 'fila' | 'sempre' } | { kind: 'revogar' }

const AUTH_LINE = /^[`\s>*-]*AUTORIZAR[\s*`_]*\|\s*(commit\s*\+\s*push|commit)\s*\|\s*(fila|sempre)[\s*`_.]*$/i
const REVOKE_LINE = /^[`\s>*-]*REVOGAR[\s*`_.]*$/i
const TITLE_CHARS = 160

/** O pedido de autorização (ou de revogação) do veredito; a última linha vale. */
export function parsePoAuthorization(raw: string): PoAuthorizationOp | null {
  const lines = (raw ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (REVOKE_LINE.test(lines[i])) return { kind: 'revogar' }
    const match = AUTH_LINE.exec(lines[i])
    if (match) return { kind: 'autorizar', push: /push/i.test(match[1]), scope: match[2].toLowerCase() as 'fila' | 'sempre' }
  }
  return null
}

function describe(auth: PoAuthorization | null): string {
  if (!auth) return 'nenhuma'
  return `${auth.push ? 'commit + push' : 'commit'} (${auth.scope === 'fila' ? 'esta fila' : 'sempre'})`
}

/** A seção da ABERTURA: como reconhecer a frase (e a barreira da fila). */
export function formatPoAuthorizationOpen(current: PoAuthorization | null, hasQueue: boolean): string {
  return [
    `AUTORIZAÇÃO DO PO NESTA CONVERSA: ${describe(current)}; fila de implantação: ${hasQueue ? 'sim' : 'não'}.`,
    'Se a mensagem do usuário AUTORIZA o PO a commitar (e/ou dar push) sozinho nesta conversa, acrescente UMA linha:',
    'AUTORIZAR | commit|commit+push | fila|sempre',
    '- "fila": vale só para a implantação em andamento ("quando terminar, commit e push"); só existe com fila de implantação.',
    '- "sempre": ele disse que pode sempre nesta conversa ("nessa conversa você pode commitar e dar push sempre").',
    '- O que fica autorizado segue a frase: só commit, ou commit+push.',
    '- Pedido de uma vez só ("commita isso") NÃO é autorização. Sem fila, "quando terminar, commit e push" é pedido normal ao agente. Na dúvida, não autorize.',
    'Se ele mandar parar ("para de commitar sozinho"), acrescente a linha: REVOGAR'
  ].join('\n')
}

/** A seção do FECHAMENTO: a pendência de commit não espera o usuário. */
export function formatPoAuthorizationClose(current: PoAuthorization): string {
  return [
    `AUTORIZAÇÕES DESTA CONVERSA: ${describe(current)}.`,
    'Com mudanças sem commit no GIT DA PASTA depois de um pedido entregue, crie a pendência de commit como sempre',
    `(NOVA <id do cartão concluído> | Commitar <o que foi feito> | <motivo>): ela não espera o usuário — o app manda o commit${current.push ? ' e o push' : ''} sozinho, como rotina.`
  ].join('\n')
}

/** A pendência de commit (ou de push, com push autorizado) vira rotina. */
export function routineFor(title: string, auth: PoAuthorization): boolean {
  if (/\bcommit/i.test(title)) return true
  return auth.push && /\bpush/i.test(title)
}

/** O título como entra no texto: uma linha, sem crase, curto. */
export function sanitizeRoutineTitle(title: string): string {
  const clean = (title ?? '')
    .replace(/[\u0000-\u001f\u007f`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > TITLE_CHARS ? `${clean.slice(0, TITLE_CHARS - 1)}…` : clean
}

/** O texto FIXO da rotina: só o título do cartão concluído entra. */
export function routineText(parentTitle: string, push: boolean): string {
  const title = sanitizeRoutineTitle(parentTitle) || 'o trabalho concluído'
  return push
    ? `Faça o commit das mudanças de: ${title} e dê push na branch atual, sem --force.`
    : `Faça o commit das mudanças de: ${title}.`
}

/** O motivo da pendência que virou rotina (não é "aguardando você"). */
export const PO_ROUTINE_REASON = 'autorizado: o commit sai sozinho, como rotina na fila'

function valid(value: unknown): value is PoAuthorization {
  const v = value as PoAuthorization
  return !!v && typeof v === 'object' && typeof v.push === 'boolean' && (v.scope === 'fila' || v.scope === 'sempre') && typeof v.at === 'string'
}

/**
 * As autorizações, gravadas numa chave do banco (escopo global: viajam com a
 * conversa e sobrevivem a reinício). Uma escrita por vez; a leitura é sempre
 * fresca (outro PC pode ter revogado).
 */
export class PoAuthorizationStore {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly deps: {
      read(): Promise<string | null>
      write(value: string): Promise<void>
      changed?(map: PoAuthorizationMap): void
    }
  ) {}

  async all(): Promise<PoAuthorizationMap> {
    try {
      const parsed = JSON.parse((await this.deps.read()) ?? '{}') as Record<string, unknown>
      const out: PoAuthorizationMap = {}
      for (const [id, value] of Object.entries(parsed ?? {})) if (valid(value)) out[id] = value
      return out
    } catch {
      return {}
    }
  }

  async get(conversationId: string): Promise<PoAuthorization | null> {
    return (await this.all())[conversationId] ?? null
  }

  /** `null` revoga. */
  async set(conversationId: string, auth: PoAuthorization | null): Promise<void> {
    const run = this.chain.then(async () => {
      const map = await this.all()
      if (auth) map[conversationId] = auth
      else if (map[conversationId]) delete map[conversationId]
      else return
      await this.deps.write(JSON.stringify(map))
      this.deps.changed?.(map)
    })
    this.chain = run.catch(() => undefined)
    await run
  }
}
