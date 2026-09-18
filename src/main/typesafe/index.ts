/**
 * A porta de entrada do TypeSafe AI no app. Quem decide importa daqui — e só
 * daqui: manter o `@typesafe-ai/sdk` contido nesta pasta é o que permite
 * trocar/abandonar o serviço mexendo num lugar só.
 *
 * As primitivas de pergunta saem reexportadas do SDK porque são valores puros
 * (montam o objeto da pergunta, não falam com a rede).
 */
export { choice, noul, score } from '@typesafe-ai/sdk'
export type {
  ChoiceResponse,
  NoulResponse,
  Questions,
  ScoreResponse,
  SystemOneResult
} from '@typesafe-ai/sdk'

export {
  askTypeSafe,
  typeSafeApiKey,
  typeSafeEnabled,
  typeSafeMinConfidence,
  TYPESAFE_SECRET_NAME,
  TYPESAFE_TIMEOUT_MS,
  type AskTypeSafeOptions
} from './client'
export {
  autoEffortCandidates,
  autoExecutionFallback,
  autoExecutionNote,
  autoModelCandidates,
  autoExecutionUnprompted,
  autoModelLabel,
  autoSupportedEfforts,
  buildAutoExecutionPayload,
  chooseAutoExecution,
  effortFromScore,
  resolveAutoStart,
  AUTO_EFFORT_DESCRIPTIONS,
  AUTO_EFFORT_INSTRUCTION,
  AUTO_MODEL_DESCRIPTIONS,
  AUTO_MODEL_INSTRUCTION,
  AUTO_NO_LIVE_MODEL,
  type AutoExecution,
  type AutoExecutionOptions,
  type AutoExecutionPayload,
  type AutoExecutionSource,
  type AutoExecutionState,
  type AutoPair,
  type AutoStartDecision,
  type AutoStartInput
} from './execution'
export {
  memorySelectionThreshold,
  selectMemoriesWithTypeSafe,
  typeSafeMemorySelectionActive,
  MEMORY_CHOICE_MAX_MEMORIES,
  MEMORY_CHOICE_MAX_OPTIONS,
  MEMORY_RANK_SCAN_MAX,
  MEMORY_SELECTION_MAJORITY,
  MEMORY_SELECTION_MAX,
  MEMORY_SELECTION_MIN_LIFT,
  MEMORY_SELECTION_NONE,
  type MemorySelection
} from './memorySelection'
export {
  buildMemoryGateState,
  memoryGateActive,
  shouldSaveMemory,
  MEMORY_GATE_MAX_HEADERS,
  MEMORY_GATE_MAX_STATE_CHARS,
  MEMORY_GATE_QUESTION,
  type MemoryGateInput
} from './memoryGate'
export {
  flushTypeSafeUsage,
  recordTypeSafeUsage,
  typeSafeUsage,
  TYPESAFE_USAGE_KEY,
  type TypeSafeUsage
} from './usage'
