/**
 * A Central na storage: UMA linha que os dois PCs gravam (ver centralMerge.ts). A
 * gravação — mesclada por dono com a base do compare-and-set, rebaseando no
 * conflito — é da fila de gravação do main. Aqui, com um atualizador registrado (o
 * App), a tela recebe o remoto mesclado por dono, em vez de trocar a Central
 * inteira: pelo feed e quando a fila relê a Central num conflito. As dependências
 * da storage vêm injetadas (storage.ts instancia): sem import circular.
 */
import { CENTRAL_ID } from '@shared/central'
import type { VersionedConversationDto } from '@shared/ipc'
import type { Conversation } from '../types'
import { mergeCentralConversation } from './centralMerge'

/** Põe na tela a Central mesclada; quem registra é o App. */
export type CentralUpdater = (fn: (local: Conversation) => Conversation) => void

export interface CentralStorageDeps {
  /** A maior revisão que as leituras já trouxeram desta conversa. */
  knownRevision(id: string): number | undefined
  normalize(record: VersionedConversationDto): Conversation
}

export function createCentralStorage(deps: CentralStorageDeps) {
  let updater: CentralUpdater | null = null
  /** A maior revisão remota já mesclada na tela. Uma leitura mais velha que chegue
   *  depois (respostas fora de ordem) não volta a tela para ela: tiraria entradas do
   *  outro PC que já apareceram aqui. */
  let screenRevision = 0

  /** Entrega à tela um registro remoto, mesclado por dono — nunca um mais velho que o
   *  último entregue. */
  function deliver(record: VersionedConversationDto, self: string | null): void {
    if (!updater || record.revision <= screenRevision) return
    screenRevision = record.revision
    const remote = deps.normalize(record)
    updater((local) => mergeCentralConversation(local, remote, self))
  }

  return {
    /** `null` desliga: a Central volta ao comportamento das outras conversas. */
    register(update: CentralUpdater | null): void {
      updater = update
    },

    /** Se a storage desvia esta conversa para cá (a Central, com atualizador). */
    handles(id: string): boolean {
      return id === CENTRAL_ID && updater !== null
    },

    /**
     * Feed: suja ou não, a tela recebe o remoto mesclado por dono — trocar a Central
     * inteira apagaria o que este PC ainda não gravou, e pular a suja esconderia o
     * outro PC até a próxima gravação daqui. A próxima gravação da fila mescla de
     * novo com o banco (o CAS garante a base). Sumida do banco: fica na tela (há UMA
     * Central; a próxima gravação a refaz).
     */
    mergeChange(record: VersionedConversationDto | undefined, self: string | null): void {
      const known = deps.knownRevision(CENTRAL_ID)
      if (!record || (known !== undefined && record.revision <= known)) return
      deliver(record, self)
    },

    /** A fila do main releu a Central num conflito: o que veio do outro PC aparece. */
    mergeRemote(record: VersionedConversationDto, self: string | null): void {
      if (record.id === CENTRAL_ID && !record.deletedAt) deliver(record, self)
    }
  }
}
