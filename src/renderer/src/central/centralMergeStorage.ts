/**
 * A Central na storage: UMA linha que os dois PCs gravam (ver centralMerge.ts). Com
 * um atualizador registrado (o App), a storage desvia a Central para cá: a gravação
 * vai mesclada por dono com a base do CAS (rebaseando até MAX_CENTRAL_REBASES vezes)
 * e o feed entrega o remoto mesclado à tela, em vez de trocar a Central inteira. As
 * dependências da storage vêm injetadas (storage.ts instancia): sem import circular.
 */
import { CENTRAL_ID } from '@shared/central'
import type { VersionedConversationDto } from '@shared/ipc'
import type { Conversation } from '../types'
import { ipcStorageErrorCode } from '../ipcError'
import { mergeCentralConversation } from './centralMerge'

/** Põe na tela a Central mesclada; quem registra é o App. */
export type CentralUpdater = (fn: (local: Conversation) => Conversation) => void

/** REVISION_CONFLICT seguidos que a gravação da Central absorve: 1 tentativa + 3
 *  rebases = até 4 upserts. As outras conversas rebaseiam uma vez só. */
export const MAX_CENTRAL_REBASES = 3

export interface CentralStorageDeps {
  /** O registro conhecido (a base do próximo compare-and-set). */
  known(id: string): VersionedConversationDto | undefined
  /** Relê o registro autoritativo (tombstone incluído) e o guarda como base. */
  reread(id: string): Promise<VersionedConversationDto | undefined>
  /** Upsert com compare-and-set na revisão esperada. */
  upsert(conversation: Conversation, expectedRevision: number | undefined): Promise<VersionedConversationDto>
  normalize(record: VersionedConversationDto): Conversation
  clean(conversation: Conversation): Conversation
  installationId(): Promise<string | null>
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
     * Toda tentativa leva a cópia local MESCLADA com o registro da revisão que ela
     * espera: as entradas do outro PC vão exatamente como estão nessa revisão, e o CAS
     * garante que a linha ainda é ela. Sem isso, uma cópia capturada antes de a tela
     * receber a mescla (debounce, fila) passaria no CAS e apagaria o que o outro PC
     * gravou. Em REVISION_CONFLICT seguidos: relê, mescla e regrava, até
     * MAX_CENTRAL_REBASES vezes; depois o conflito sobe e o próximo salvamento tenta de
     * novo. A tela ganha o último remoto relido, com sucesso ou não.
     */
    async write(conversation: Conversation): Promise<VersionedConversationDto> {
      const self = await deps.installationId()
      const mergedWith = (base: VersionedConversationDto | undefined): Conversation => {
        if (!base) return conversation
        const merged = mergeCentralConversation(conversation, deps.normalize(base), self)
        return merged === conversation ? conversation : deps.clean(merged)
      }
      let base = deps.known(conversation.id)
      let remote: VersionedConversationDto | undefined
      try {
        for (let rebases = 0; ; rebases += 1) {
          try {
            return await deps.upsert(mergedWith(base), base?.revision)
          } catch (error) {
            if (rebases >= MAX_CENTRAL_REBASES || ipcStorageErrorCode(error) !== 'REVISION_CONFLICT') throw error
            base = remote = await deps.reread(conversation.id)
          }
        }
      } finally {
        if (remote) deliver(remote, self)
      }
    },

    /**
     * Feed: suja ou não, a tela recebe o remoto mesclado por dono — trocar a Central
     * inteira apagaria o que este PC ainda não gravou, e pular a suja esconderia o
     * outro PC até a próxima gravação daqui. A revisão conhecida NÃO avança: uma
     * gravação capturada antes desta mescla (na fila, no debounce) ainda tem de perder
     * o CAS e mesclar com o banco. Sumida do banco: fica na tela (há UMA Central; a
     * próxima gravação a refaz).
     */
    mergeChange(record: VersionedConversationDto | undefined, self: string | null): void {
      const known = deps.known(CENTRAL_ID)
      if (!record || (known && record.revision <= known.revision)) return
      deliver(record, self)
    }
  }
}
