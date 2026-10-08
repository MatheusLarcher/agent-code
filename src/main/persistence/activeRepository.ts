import type { SessionStore } from '@anthropic-ai/claude-agent-sdk'
import {
  StorageError,
  type ContextHistoryRepository,
  type PersistenceRepository,
  type TokenUsageRepository
} from './types'

/**
 * Acesso ao repositório ATIVO na hora de cada chamada.
 *
 * Uma sessão de agente vive mais que o repositório em que nasceu: numa queda do
 * PostgreSQL, `setOffline` fecha o repositório (pool.end()) e a reconexão
 * automática instala outro. Quem guardou a instância antiga (o sessionStore do
 * espelho, a verificação do fim de turno, `llm_calls`, o reparo) passava a
 * falhar com "Cannot use a pool after calling end on the pool" e a conversa
 * travava até ser reaberta. Aqui cada chamada pergunta ao resolvedor qual é o
 * repositório de agora — o mesmo que o `leaseKeeper` já fazia. Offline, o
 * resolvedor lança STORAGE_OFFLINE (retryable), que o reparo trata como
 * transitório.
 */
export type RepositoryResolver = () => PersistenceRepository

type OptionalStoreMethod = 'listSessions' | 'listSessionSummaries' | 'delete' | 'listSubkeys'
const OPTIONAL_STORE_METHODS: readonly OptionalStoreMethod[] = ['listSessions', 'listSessionSummaries', 'delete', 'listSubkeys']

function isStillActive(resolve: RepositoryResolver, used: PersistenceRepository): boolean {
  try {
    return resolve() === used
  } catch {
    return false
  }
}

/** Roda `work` no repositório ativo. Uma chamada que já estava em curso quando
 *  `setOffline` fez pool.end() (ou a reconexão trocou o repositório) falha com
 *  "Cannot use a pool after calling end", que não é transitório e faria o
 *  reparo do espelho desistir de vez. Se o repositório usado deixou de ser o
 *  ativo, a falha vira STORAGE_OFFLINE (retryable): a próxima tentativa vai para
 *  o repositório de agora. Se ele continua ativo, o erro é dele e sobe como veio
 *  (um pool encerrado que ainda é o ativo continua definitivo). */
async function onActive<T>(resolve: RepositoryResolver, work: (repository: PersistenceRepository) => Promise<T>): Promise<T> {
  const repository = resolve()
  return guarded(resolve, repository, () => work(repository))
}

async function guarded<T>(resolve: RepositoryResolver, used: PersistenceRepository, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (isStillActive(resolve, used)) throw error
    throw new StorageError('STORAGE_OFFLINE', 'O repositório foi trocado ou fechado durante a chamada.', true, { cause: error })
  }
}

type StoreCall = <T>(work: (store: SessionStore) => Promise<T>) => Promise<T>

/** Monta o SessionStore exposto: `append`/`load` sempre, e só os métodos
 *  opcionais que `template` oferece (o SDK decide pelo que existe). */
function wrapStore(template: SessionStore, call: StoreCall): SessionStore {
  const store: SessionStore = {
    append: async (key, entries) => call((target) => target.append(key, entries)),
    load: async (key) => call((target) => target.load(key))
  }
  for (const name of OPTIONAL_STORE_METHODS) {
    if (!template[name]) continue
    Object.assign(store, {
      [name]: async (...args: unknown[]) =>
        call(async (target) => {
          const method = target[name] as ((...params: unknown[]) => Promise<unknown>) | undefined
          if (!method) throw new StorageError('STORAGE_OFFLINE', `O repositório ativo não oferece ${name}.`)
          return method.apply(target, args)
        })
    })
  }
  return store
}

/** SessionStore da conversa que segue o repositório ativo. Os métodos opcionais
 *  expostos são os do store do repositório atual; cada repositório ganha um
 *  store só, criado na primeira chamada que cai nele. */
export function activeSessionStore(resolve: RepositoryResolver, conversationId: string): SessionStore {
  const stores = new WeakMap<PersistenceRepository, SessionStore>()
  const storeFor = (repository: PersistenceRepository): SessionStore => {
    let store = stores.get(repository)
    if (!store) {
      store = repository.createSessionStore(conversationId)
      stores.set(repository, store)
    }
    return store
  }
  return wrapStore(storeFor(resolve()), (work) => onActive(resolve, (repository) => work(storeFor(repository))))
}

/** Store do REPLAY do reparo: tem estado por tentativa, então fica preso ao
 *  repositório ativo na hora da criação — mas uma falha depois de esse
 *  repositório ser trocado/fechado sai como STORAGE_OFFLINE (transitório), e a
 *  próxima tentativa do reparo cria outro no repositório de agora. */
export function activeReplayStore(
  resolve: RepositoryResolver,
  conversationId: string,
  fallback: () => SessionStore
): SessionStore {
  const repository = resolve()
  const target = repository.createSessionReplayStore?.(conversationId) ?? fallback()
  return wrapStore(target, (work) => guarded(resolve, repository, () => work(target)))
}

/** `llm_calls` pelo repositório ativo. */
export function activeTokenUsage(resolve: RepositoryResolver): TokenUsageRepository {
  return {
    insertLlmCall: async (input) => onActive(resolve, (repository) => repository.insertLlmCall(input)),
    updateLlmCall: async (id, usage) => onActive(resolve, (repository) => repository.updateLlmCall(id, usage)),
    listLlmCalls: async (conversationId) => onActive(resolve, (repository) => repository.listLlmCalls(conversationId)),
    listLlmUsageTotals: async (conversationId) =>
      onActive(resolve, (repository) => repository.listLlmUsageTotals(conversationId)),
    insertTurnTime: async (input) => onActive(resolve, (repository) => repository.insertTurnTime(input)),
    turnTimeTotals: async (conversationId) => onActive(resolve, (repository) => repository.turnTimeTotals(conversationId))
  }
}

/** Histórico do contexto (`context_turn`/`context_blob`) pelo repositório ativo. */
export function activeContextHistory(resolve: RepositoryResolver): ContextHistoryRepository {
  return {
    saveContextTurn: async (write) => onActive(resolve, (repository) => repository.saveContextTurn(write)),
    listContextTurns: async (convId, limit) => onActive(resolve, (repository) => repository.listContextTurns(convId, limit)),
    readContextTurn: async (convId, turnId) => onActive(resolve, (repository) => repository.readContextTurn(convId, turnId)),
    deleteContextTurns: async (convId) => onActive(resolve, (repository) => repository.deleteContextTurns(convId)),
    pruneOrphanContextBlobs: async () => onActive(resolve, (repository) => repository.pruneOrphanContextBlobs())
  }
}

/** `markSessionResumeReady` (fim de turno, `verifyMirroredSession`) pelo repositório ativo. */
export function activeResumeMarker(resolve: RepositoryResolver): Pick<PersistenceRepository, 'markSessionResumeReady'> {
  return {
    markSessionResumeReady: async (conversationId, sessionId, ready, verifiedHash) =>
      onActive(resolve, (repository) => repository.markSessionResumeReady(conversationId, sessionId, ready, verifiedHash))
  }
}
