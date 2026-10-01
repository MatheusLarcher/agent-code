/**
 * Máquina da reunião (card req-reuniao): decide, por conversa e por instante,
 * se o principal fica 'na mesa' ou vai/fica 'na reunião'. Pura quanto ao
 * relógio (o instante vem de quem chama) e sem tocar no motor: quem anda é o
 * adaptador (adapter/meetingDriver).
 *
 * Gatilhos de ida (os quatro escolhidos pelo usuário em 01/10/2026):
 *   1. rascunho ativo há ≥ DRAFT_MIN_MS com input recente, ou microfone ligado;
 *   2. envio recente (sentAt);
 *   3. pedido do agente ao usuário (permissão, AskUserQuestion, dúvida do vigia);
 *   4. conversa de planejamento ativa (o Gerente fica lá enquanto ela estiver).
 * Volta: o turno passa a usar ferramenta; RETURN_MS depois de apagar o rascunho
 * sem envio; ou RETURN_MS sem input com o rascunho "ligado" (o draftActiveSince
 * que sobra ao trocar de conversa, pendência da F3·1). Pedido pendente segura
 * lá até ser resolvido, mesmo com ferramenta.
 */
import type { ComposerPresence } from '../../composerPresence'

/** Proteção contra vaivém: rascunho precisa estar ativo por este tempo. */
export const DRAFT_MIN_MS = 1000
/** Espera antes de voltar à mesa (rascunho apagado ou parado). */
export const RETURN_MS = 8000

export interface MeetingInput {
  presence: ComposerPresence
  /** A conversa tem turno rodando. */
  busy: boolean
  /** O turno do principal está numa ferramenta agora. */
  toolInUse: boolean
  /** Permissão, pergunta ou dúvida do vigia esperando o usuário. */
  pending: boolean
  /** Conversa de planejamento ativa. */
  planning: boolean
}

export type MeetingReason = 'pedido' | 'planejamento' | 'microfone' | 'rascunho' | 'envio' | 'apagado'

export type MeetingPlace = 'mesa' | 'reuniao'

export interface MeetingVerdict {
  place: MeetingPlace
  reason: MeetingReason | null
  /** Instante em que a resposta pode mudar sem entrada nova; null = só com entrada nova. */
  recheckAt: number | null
}

export interface Meeting {
  evaluate(convId: string, input: MeetingInput, now: number): MeetingVerdict
  /** Esquece a conversa (saiu do escritório). */
  forget(convId: string): void
}

interface Memory {
  place: MeetingPlace
  /** sentAt do envio cujo turno já usou ferramenta: esse envio não leva mais lá. */
  toolForSent: number | null | undefined
}

const at = (place: MeetingPlace, reason: MeetingReason | null, recheckAt: number | null = null): MeetingVerdict => ({
  place,
  reason,
  recheckAt
})

/** Regra sem efeito colateral além da memória da própria conversa. */
function decide(mem: Memory, input: MeetingInput, now: number): MeetingVerdict {
  const { presence: p } = input
  if (input.pending) return at('reuniao', 'pedido')
  if (input.planning) return at('reuniao', 'planejamento')
  if (input.toolInUse) {
    // O turno deste envio foi trabalhar: o envio não o chama de volta.
    mem.toolForSent = p.sentAt
    return at('mesa', null)
  }
  if (p.micOn) return at('reuniao', 'microfone')

  const wasThere = mem.place === 'reuniao'
  let wait: number | null = null
  const later = (t: number): void => {
    wait = wait === null ? t : Math.min(wait, t)
  }

  // 1) Rascunho: só com input recente; parado há RETURN_MS conta como largado.
  const d = p.draftActiveSince
  const l = p.lastInputAt
  if (d !== null && l !== null && now - l < RETURN_MS) {
    if (now - d >= DRAFT_MIN_MS || wasThere) return at('reuniao', 'rascunho', l + RETURN_MS)
    later(d + DRAFT_MIN_MS)
  }

  // 2) Envio recente (ou o turno dele ainda rodando sem ferramenta, já lá).
  const s = p.sentAt
  if (s !== null && mem.toolForSent !== s) {
    if (now - s < RETURN_MS) return at('reuniao', 'envio', input.busy ? null : s + RETURN_MS)
    if (input.busy && wasThere) return at('reuniao', 'envio')
  }

  // Apagou o rascunho sem enviar: espera RETURN_MS lá antes de voltar.
  const c = p.clearedAt
  if (wasThere && c !== null && now - c < RETURN_MS && (s === null || c > s)) {
    return at('reuniao', 'apagado', c + RETURN_MS)
  }
  return at('mesa', null, wait)
}

export function createMeeting(): Meeting {
  const byConv = new Map<string, Memory>()
  return {
    evaluate(convId, input, now) {
      let mem = byConv.get(convId)
      if (!mem) {
        mem = { place: 'mesa', toolForSent: undefined }
        byConv.set(convId, mem)
      }
      const v = decide(mem, input, now)
      mem.place = v.place
      return v
    },
    forget(convId) {
      byConv.delete(convId)
    }
  }
}
