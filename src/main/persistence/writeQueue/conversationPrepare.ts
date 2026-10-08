import { compactConversation } from '../../../shared/conversationCompaction'
import { splitDeviceFields } from '../conversationScope'
import { hashJson, type JsonValue } from '../hashes'
import { encodePostgresJsonParam } from '../postgresEncoding'
import { StorageError, type ConversationRecord } from '../types'

/** Sobre o que o backend calcula o `content_hash` da conversa: o PostgreSQL usa só a
 *  parte compartilhada (o estado do dispositivo vai à parte); o SQLite, o documento
 *  inteiro. A fila compara com o mesmo cálculo para pular gravação sem mudança. */
export type ConversationHashScope = 'shared' | 'full'

/** O documento pronto para gravar, calculado fora do thread principal. */
export interface PreparedConversation {
  /** O documento limpo inteiro, em JSON (o SQLite grava este). */
  payloadJson: string
  /** A parte compartilhada, já no formato do parâmetro `jsonb` (PostgreSQL). */
  sharedParam: string
  contentHash: string
  /** Estado deste dispositivo (pasta, rascunho), no formato do parâmetro `jsonb`. */
  deviceParam: string
  deviceHash: string
  /** Identidade do projeto, para o mapeamento por pasta. */
  project: { projectId: string; signature: string; remoteGit: string | null }
  cwd: string
}

/**
 * O que ia para o banco pelo renderer (`cleanConversation`): compactação de
 * conversa velha, carimbo da separação dos Automáticos e nada de `images` (bytes
 * de imagem nunca vão para o banco), em qualquer profundidade — e, de quebra, a
 * normalização por ida e volta de JSON que o repositório fazia em toda gravação.
 */
export function prepareConversation(
  doc: ConversationRecord,
  scope: ConversationHashScope,
  now = Date.now()
): PreparedConversation {
  const stamped = { ...compactConversation(doc, now), effortSplit: true }
  const text = JSON.stringify(stamped, (key, value: unknown) => (key === 'images' ? undefined : value))
  const clean = JSON.parse(text) as unknown
  if (typeof clean !== 'object' || clean === null || Array.isArray(clean)) {
    throw new StorageError('INVALID_PERSISTED_DATA', 'Payload de conversa inválido.')
  }
  const record = clean as ConversationRecord
  if (typeof record.id !== 'string' || !record.id) {
    throw new StorageError('INVALID_PERSISTED_DATA', 'Conversa sem ID não pode ser salva.')
  }
  const { shared, device } = splitDeviceFields(record)
  const contentHash = hashJson((scope === 'shared' ? shared : record) as JsonValue)
  return {
    payloadJson: text,
    sharedParam: encodePostgresJsonParam(shared as JsonValue),
    contentHash,
    deviceParam: encodePostgresJsonParam(device as JsonValue),
    deviceHash: hashJson(device as JsonValue),
    project: {
      projectId: typeof shared.projectId === 'string' ? shared.projectId : '',
      signature: typeof shared.projectSignature === 'string' ? shared.projectSignature : '',
      remoteGit: typeof shared.projectRemoteGit === 'string' ? shared.projectRemoteGit : null
    },
    cwd: typeof device.cwd === 'string' ? device.cwd : ''
  }
}
