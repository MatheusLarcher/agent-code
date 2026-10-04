/**
 * A parte da window.api que o Escritório usa (a AgentCodeApi a estende): o HTML
 * do agente na TV, os chamados e o resumo do plano para a TV.
 */
import type { PlanningRef, PlanningResult } from './ipc'
import type { OfficeCallOpen, OfficeCallsState } from './officeCall'
import type { MemoryListItem, MemoryReadResult } from './memoryPanel'
import type { MockupCaptureResult, MockupRequest, MockupUrlResult } from './officeMockup'

/** O resumo de um plano para a TV (sem abrir a vigia da pasta). */
export interface PlanningPeekDto {
  titulo: string
  etapas: { titulo: string; status: 'pendente' | 'em_andamento' | 'concluida' }[]
  cards: number
  ambiguidadesAbertas: number
}

export interface OfficeApi {
  /** O HTML do agente: endereço no protocolo agent-mockup (iframe do foco) e captura para a TV em 3D. */
  officeMockupUrl(req: MockupRequest): Promise<MockupUrlResult>
  officeMockupCapture(req: MockupRequest): Promise<MockupCaptureResult>
  /** Os chamados do agente (shared/officeCall.ts): o estado que só a interface sabe, e o clique na notificação. */
  officeCallsState(state: OfficeCallsState): Promise<void>
  onOfficeCallOpen(cb: (e: OfficeCallOpen) => void): () => void
  /** O resumo do plano para a TV (só leitura, sem vigia). */
  planningPeek(req: PlanningRef): Promise<PlanningResult<{ plan: PlanningPeekDto }>>
  /** O painel de Memórias (só leitura): a lista e o texto de uma (segredos só como marca). */
  memoryListEntries(): Promise<MemoryListItem[]>
  memoryReadEntry(relPath: string): Promise<MemoryReadResult | null>
}
