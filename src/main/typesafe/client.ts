import {
  TypeSafeClient,
  type EntryType,
  type Questions,
  type SystemOneResult
} from '@typesafe-ai/sdk'
import { createHash } from 'node:crypto'
import { ensureConfigLoaded, loadConfig } from '../config'
import { readSecret } from '../memory/memoryRuntime'
import { typeSafePause } from './pause'
import { recordTypeSafeUsage } from './usage'

/**
 * O cliente compartilhado do TypeSafe AI.
 *
 * O serviço responde perguntas tipadas (`choice`/`score`/`noul`) em ~100ms com
 * probabilidade calibrada. Quem chama é código de decisão que roda ANTES ou
 * DURANTE o turno do usuário, então a regra desta camada é uma só: nunca
 * lançar e nunca demorar. Modo desligado, chave ausente, timeout, 401, 429 ou
 * queda de rede devolvem `null` — o chamador segue pelo caminho que já valia.
 */

/** Nome da credencial no cofre de segredos, quando a chave não está na config. */
export const TYPESAFE_SECRET_NAME = 'typesafe_api_key'

/**
 * 8s por tentativa e ZERO retentativas. Esta chamada fica na frente do envio da
 * mensagem do usuário: encadear backoff multiplicaria a espera por uma decisão
 * que é, por definição, dispensável. Falhou, segue sem ela.
 */
export const TYPESAFE_TIMEOUT_MS = 8000

/** O interruptor do usuário. Leitura viva, nunca em cache. */
export function typeSafeEnabled(): boolean {
  return loadConfig().typesafe.enabled === true
}

/** Piso de confiança configurado para agir sozinho com base numa resposta. */
export function typeSafeMinConfidence(): number {
  return loadConfig().typesafe.minConfidence
}

/**
 * A chave, da config ou — quando ela está vazia — do cofre de segredos.
 *
 * O cofre é o segundo lugar porque é onde o usuário já guarda credencial, e
 * porque isso deixa a chave viajar junto da pasta de dados. `null` quando não
 * há nenhuma das duas, ou quando o cofre está desligado/indisponível.
 */
export async function typeSafeApiKey(): Promise<string | null> {
  const fromConfig = loadConfig().typesafe.apiKey.trim()
  if (fromConfig) return fromConfig
  try {
    const fromVault = (await readSecret(TYPESAFE_SECRET_NAME))?.trim()
    return fromVault ? fromVault : null
  } catch {
    // Cofre desligado, sem criptografia no sistema ou arquivo ilegível: para
    // esta camada é o mesmo que não ter chave.
    return null
  }
}

/** Ligado E com chave utilizável (config ou cofre) — o que a UI precisa saber
 *  antes de deixar escolher "Automático".
 *
 *  Espera `ensureConfigLoaded()` primeiro: chamado logo após o boot (o
 *  seletor de modelo consulta isto ao montar), a leitura direta de
 *  `typeSafeEnabled()` podia cair no fallback local ANTES de a config
 *  autoritativa terminar de carregar e responder "desativado" mesmo já
 *  ativado — mesma corrida que existia em `codexStatus()`. */
export async function typeSafeConfigured(): Promise<boolean> {
  await ensureConfigLoaded()
  if (!typeSafeEnabled()) return false
  return (await typeSafeApiKey()) !== null
}

/** Impressão digital da chave: a pausa compara chaves sem guardar a chave. */
function keyFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16)
}

export interface AskTypeSafeOptions {
  /** Cancela a chamada junto com o trabalho que a pediu. */
  signal?: AbortSignal
  /** Sobrepõe `TYPESAFE_TIMEOUT_MS` em caminho que não bloqueia o usuário. */
  timeout?: number
}

/**
 * Faz uma rodada de perguntas ao Jev e devolve só as respostas, já tipadas
 * pelas perguntas enviadas. `null` em TODO caminho de falha.
 *
 * Várias perguntas na mesma chamada rodam em paralelo no serviço: custam
 * tokens a mais, não latência a mais.
 */
export async function askTypeSafe<const Q extends Questions>(
  request: { state: EntryType; questions: Q },
  options: AskTypeSafeOptions = {}
): Promise<SystemOneResult<Q>['answers'] | null> {
  if (!typeSafeEnabled()) return null
  if (!Object.keys(request.questions).length) return null
  const apiKey = await typeSafeApiKey()
  if (!apiKey) return null
  // Em pausa (chave recusada, serviço fora): segue direto com o par padrão,
  // sem esperar nada. Chave trocada sai da pausa sozinha.
  const fingerprint = keyFingerprint(apiKey)
  if (typeSafePause.isPaused(fingerprint)) return null

  try {
    const client = new TypeSafeClient({ apiKey })
    const { answers, usage } = await client.systemOne(request, {
      timeout: options.timeout ?? TYPESAFE_TIMEOUT_MS,
      retry: { maxRetries: 0 },
      ...(options.signal ? { signal: options.signal } : {})
    })
    // Sem `await`: a resposta já está na mão, e a contabilidade não pode
    // atrasar quem está esperando a decisão.
    void recordTypeSafeUsage(usage)
    typeSafePause.recordSuccess()
    return answers
  } catch (error) {
    typeSafePause.recordFailure(error, fingerprint)
    // Só a mensagem do erro — nunca a chave, nunca o `state`, que carrega o
    // conteúdo da conversa.
    console.error(`[typesafe] decisão descartada: ${(error as Error)?.message ?? error}`)
    return null
  }
}
