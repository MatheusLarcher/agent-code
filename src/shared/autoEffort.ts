import {
  AUTO_EFFORT,
  clampEffortToModel,
  EFFORT_LEVELS,
  isAutoEffort,
  isAutoModel,
  MODEL_EFFORT,
  type EffortChoice,
  type EffortLevel
} from './ipc'

/**
 * O esforço Automático separado do modelo Automático: a barreira final antes do
 * SDK e a migração dos registros gravados antes da separação.
 */

/** O valor é um degrau concreto da escada de esforço? */
export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && EFFORT_LEVELS.includes(value as EffortLevel)
}

/**
 * O esforço que pode sair do processo para o SDK/CLI, ou `undefined` para não
 * mandar esforço nenhum.
 *
 * É a ÚLTIMA barreira: o sentinel `auto` (e qualquer texto que não seja um
 * degrau) nunca vira `--effort`; um degrau que o modelo não aceita é recortado
 * por `clampEffortToModel`, porque o provedor recusa o par em vez de degradá-lo.
 */
export function sdkEffort(model: string | undefined, effort: unknown): EffortLevel | undefined {
  if (!isEffortLevel(effort)) return undefined
  return clampEffortToModel(model, effort)
}

/**
 * Os degraus que o seletor de esforço oferece para `model`: a escada inteira no
 * modelo Automático (o esforço é recortado depois, ao modelo que sair), a do
 * modelo fixo em MODEL_EFFORT, ou nenhum — modelo sem esforço (Ollama) esconde
 * o controle.
 */
export function effortLadderFor(model: string | undefined): readonly EffortLevel[] {
  if (!model) return []
  if (isAutoModel(model)) return EFFORT_LEVELS
  return MODEL_EFFORT[model] ?? []
}

/**
 * O esforço que fica gravado ao trocar de modelo. As duas dimensões são
 * independentes: o Automático do esforço continua Automático, e um nível fixo
 * continua o mesmo (recortado ao modelo novo). Modelo sem esforço volta ao
 * `fallback` — um `auto` ali faria o main consultar o decisor à toa.
 */
export function effortForModelChange(
  model: string,
  current: string | undefined,
  fallback: EffortLevel
): EffortChoice {
  if (effortLadderFor(model).length === 0) return fallback
  if (isAutoEffort(current)) return AUTO_EFFORT
  return clampEffortToModel(model, isEffortLevel(current) ? current : fallback)
}

/**
 * Marcador por registro de conversa: `true` = o registro já está no formato em
 * que o esforço Automático é independente do modelo Automático.
 *
 * Toda escrita deste build carimba o marcador (ver `cleanConversation` em
 * src/renderer/src/storage.ts), então um registro SEM ele só pode ter sido
 * gravado antes da separação — quando `model:'auto'` decidia o esforço também.
 * É isso que torna a migração one-shot: depois de migrado e regravado, um
 * "Automático + Alto" escolhido de propósito não volta a virar `auto`.
 *
 * A leitura NÃO força regravação (normalização sozinha nunca vira escrita, e
 * no PostgreSQL isso seria um UPDATE por conversa no primeiro boot): até a
 * próxima escrita o registro continua no formato antigo, e migrá-lo de novo dá
 * o mesmo resultado; qualquer escolha do usuário é uma escrita — já com o marcador.
 */
export const EFFORT_SPLIT_FIELD = 'effortSplit'

type EffortRecord = { model?: unknown; effort?: unknown; effortSplit?: unknown }

/**
 * Conversa carregada do banco no formato novo. Registro antigo com
 * `model:'auto'` passa a ter `effort:'auto'` (era o TypeSafe quem decidia o
 * esforço dele); o resto só ganha o marcador. Idempotente.
 */
export function migrateConversationEffort<T extends EffortRecord>(record: T): T & { effortSplit: true } {
  if (record.effortSplit === true) return record as T & { effortSplit: true }
  const legacyAuto =
    typeof record.model === 'string' && isAutoModel(record.model) && !isAutoEffort(record.effort as string)
  return { ...record, ...(legacyAuto ? { effort: AUTO_EFFORT } : {}), effortSplit: true }
}

/**
 * O mesmo para o config do Agent Manager, que tem marcador próprio (uma chave
 * do KV, ver src/main/config.ts). Devolve o MESMO objeto quando não há o que
 * mudar, para quem chama saber se precisa gravar.
 */
export function migratePlanningEffort<T extends { model: string; effort: string }>(planning: T): T {
  if (!isAutoModel(planning.model) || isAutoEffort(planning.effort)) return planning
  return { ...planning, effort: AUTO_EFFORT }
}
