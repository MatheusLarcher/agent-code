/**
 * Fatos brutos do composer de cada conversa, para o escritório de agentes:
 * o personagem vai à mesa de reunião quando o usuário começa a falar com o
 * agente (digitando ou ditando) e volta depois de o rascunho ser apagado.
 *
 * Este módulo só REGISTRA o que aconteceu; quem decide ir e voltar (e com que
 * atraso) é a máquina de reunião. Fica fora do React de propósito: o Composer
 * publica sem setState e sem passar nada pelo App, então digitar não re-renderiza
 * o app (o problema que já existiu com o rascunho, ver Composer.flushDraft).
 *
 * Todo instante vem de quem publica (`now`): o Composer passa `Date.now()` e os
 * testes passam um relógio próprio.
 */

export interface ComposerPresence {
  /** Início do rascunho não vazio atual; null sem rascunho (vazio, apagado ou enviado). */
  readonly draftActiveSince: number | null
  /** Última edição do rascunho ou troca do microfone. Muda a cada tecla, por isso
   *  SOZINHO não avisa ninguém: quem quer saber "alterado há pouco" lê via `get`. */
  readonly lastInputAt: number | null
  readonly micOn: boolean
  /** Último envio pelo composer desta conversa. */
  readonly sentAt: number | null
  /** Última vez que o rascunho ficou vazio SEM envio. */
  readonly clearedAt: number | null
}

/** Recebe a conversa que mudou: quem ouve lê só ela (`get`), sem varrer as outras. */
export type PresenceListener = (convId: string) => void

export interface ComposerPresenceStore {
  get(convId: string): ComposerPresence
  /** Devolve a função que cancela a inscrição. */
  subscribe(cb: PresenceListener): () => void
  noteDraft(convId: string, text: string, now: number): void
  noteMic(convId: string, on: boolean, now: number): void
  noteSent(convId: string, now: number): void
}

/** Conversa sem nenhum fato ainda. Congelado: é o mesmo objeto para todas. */
const IDLE: ComposerPresence = Object.freeze({
  draftActiveSince: null,
  lastInputAt: null,
  micOn: false,
  sentAt: null,
  clearedAt: null
})

/** Só espaço em branco não é rascunho (o envio também o recusa). Anexo no texto
 *  (U+FFFC, ver inlineMedia) não é espaço: conta como conteúdo. */
const hasContent = (text: string): boolean => /\S/.test(text)

/** Muda algo que vale aviso? `lastInputAt` fica de fora (ver o campo). */
const sameSignal = (a: ComposerPresence, b: ComposerPresence): boolean =>
  a.draftActiveSince === b.draftActiveSince &&
  a.micOn === b.micOn &&
  a.sentAt === b.sentAt &&
  a.clearedAt === b.clearedAt

export function createComposerPresence(): ComposerPresenceStore {
  const byConv = new Map<string, ComposerPresence>()
  const listeners = new Set<PresenceListener>()

  const get = (convId: string): ComposerPresence => byConv.get(convId) ?? IDLE

  // Cada estado é um objeto novo (quem guardou o anterior não o vê mudar).
  const put = (convId: string, prev: ComposerPresence, next: ComposerPresence): void => {
    if (sameSignal(prev, next) && prev.lastInputAt === next.lastInputAt) return
    byConv.set(convId, next)
    if (sameSignal(prev, next)) return
    for (const cb of listeners) {
      // Um ouvinte com defeito não pode travar a digitação nem calar os outros.
      try {
        cb(convId)
      } catch (err) {
        console.error('[composerPresence] ouvinte falhou', err)
      }
    }
  }

  return {
    get,
    subscribe(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    noteDraft(convId, text, now) {
      const prev = get(convId)
      const full = hasContent(text)
      put(convId, prev, {
        ...prev,
        lastInputAt: now,
        // O início se mantém enquanto o texto segue não vazio: é ele que diz há
        // quanto tempo o usuário está escrevendo, não a última tecla.
        draftActiveSince: full ? (prev.draftActiveSince ?? now) : null,
        // Só esvaziar um rascunho ativo é "apagou sem enviar". O envio zera
        // draftActiveSince antes (noteSent), então o esvaziamento dele não entra.
        clearedAt: !full && prev.draftActiveSince !== null ? now : prev.clearedAt
      })
    },
    noteMic(convId, on, now) {
      const prev = get(convId)
      if (prev.micOn === on) return
      put(convId, prev, { ...prev, micOn: on, lastInputAt: now })
    },
    noteSent(convId, now) {
      const prev = get(convId)
      // O rascunho enviado acabou aqui: o campo que se esvazia em seguida não é
      // "apagado sem envio". Não depende da ordem dos instantes (relógio de parede).
      put(convId, prev, { ...prev, sentAt: now, draftActiveSince: null })
    }
  }
}

/** A instância do app: o Composer publica, o escritório lê. */
export const composerPresence = createComposerPresence()
