/**
 * O Scrum Master visto pela tela: as decisões do diário (`scrum-decisions.log`,
 * gravado pelo main em src/main/scrum) e o contrato do painel do escritório 3D
 * (Agora / Histórico / Conversa com o SM). Os tipos do diário moram aqui para o
 * renderer ler as mesmas linhas; main/scrum/scrumTypes.ts os reexporta.
 */

/** Os marcos do SM, em % do prazo da etapa. */
export type ScrumMarco = 150 | 200 | 300

/** O que fez o SM agir: um marco ou a cobrança não entregue com turno rodando. */
export type ScrumGatilho = ScrumMarco | 'travado'

/** Os tipos de desvio que o modelo pode apontar (a palavra exata da linha DESVIO). */
export const SCRUM_DESVIOS = ['reexplorando', 'laco-de-teste', 'fora-do-escopo', 'esperando-sem-avisar'] as const
export type ScrumTipoDesvio = (typeof SCRUM_DESVIOS)[number]

/** `falha` = o modelo não respondeu ou respondeu sem veredito. */
export type ScrumVereditoTipo = 'justificado' | 'desvio' | 'parar' | 'falha'

/**
 * O que cada linha do diário registra. `resposta` = o primeiro texto do agente
 * depois da cobrança entregue (ou do corte); `contestado` = o usuário marcou a
 * decisão `refId` como errada; `aprovou`/`recusou` = a decisão do usuário sobre
 * a declaração de tarefa demorada acima do teto.
 */
export type ScrumDecisaoTipo =
  | 'cobrou'
  | 'entregue'
  | 'deixou-seguir'
  | 'avisou'
  | 'interrompeu'
  | 'parou'
  | 'declarou'
  | 'falha'
  | 'contestado'
  | 'resposta'
  | 'aprovou'
  | 'recusou'

/**
 * Uma decisão do SM = uma linha do diário permanente. `motivo` é o do SM e
 * `cobranca` é o que foi ao agente. `texto` só existe em `resposta` (o texto do
 * agente) e em `contestado` — a ÚNICA linha com texto do usuário.
 */
export interface ScrumDecisao {
  id: string
  /** ISO. */
  at: string
  tipo: ScrumDecisaoTipo
  convId: string
  conversationTitle: string | null
  envioId: string
  entregaId: string | null
  etapaId: string | null
  /** A posição da etapa no plano (a "Etapa N" dos avisos). */
  etapaN: number | null
  projectCwd: string | null
  marco: ScrumGatilho | null
  veredito: ScrumVereditoTipo | null
  tipoDesvio: ScrumTipoDesvio | null
  motivo: string | null
  cobranca: string | null
  tempoAtivoMs: number | null
  /** O prazo da etapa em minutos, como o plano deu (sem a escala de dev). */
  prazoMin: number | null
  declaradoMin: number | null
  /** Desde a declaração (deixou-seguir/interrompeu) ou desde a cobrança pendente. */
  decorridoMs: number | null
  /** O modelo consultado (a rota do julgamento). */
  rota: string | null
  durationMs: number | null
  /** A decisão a que esta linha se refere (`resposta`, `contestado`, `aprovou`, `recusou`). */
  refId?: string | null
  /** O texto do agente (`resposta`) ou a frase do usuário (`contestado`). */
  texto?: string | null
}

/** O usuário também recebeu o aviso desta decisão (as regras do `notice` do ScrumMaster). */
export function avisouVoce(d: Pick<ScrumDecisao, 'tipo' | 'marco'>): boolean {
  if (d.tipo === 'avisou' || d.tipo === 'parou' || d.tipo === 'interrompeu') return true
  return (d.tipo === 'cobrou' || d.tipo === 'falha') && typeof d.marco === 'number' && d.marco >= 200
}

// ---------------------------------------------------------------------------
// Aba "Agora": um cartão por envio acompanhado.
// ---------------------------------------------------------------------------

export type ScrumEnvioEstado = 'no-prazo' | 'atrasado' | 'parado'

/** Um balão da troca SM ↔ agente no cartão do envio. */
export interface ScrumFala {
  id: string
  at: string
  quem: 'sm' | 'agente'
  marco: ScrumGatilho | null
  veredito: ScrumVereditoTipo | null
  tipoDesvio: ScrumTipoDesvio | null
  texto: string
  /** O usuário também recebeu o aviso desta decisão. */
  avisouVoce: boolean
}

export interface ScrumEnvioView {
  envioId: string
  convId: string
  conversationTitle: string
  projectCwd: string
  estado: ScrumEnvioEstado
  /** Tempo ativo da etapa ÷ prazo; `null` sem prazo. */
  vezes: number | null
  etapaN: number | null
  etapaTotal: number
  etapaTitulo: string | null
  entregaId: string | null
  tempoAtivoMs: number
  prazoMin: number | null
  /** Os marcos desta etapa que o SM já disparou. */
  marcos: ScrumMarco[]
  falas: ScrumFala[]
  /** A última cobrança ainda não teve resposta do agente. */
  semResposta: boolean
  /** O motivo da parada (sem o prefixo "Scrum Master: "); só no `parado`. */
  paradoMotivo: string | null
  /** O próximo prompt da conversa que espera na fila (o "Tirar da fila"). */
  proximoNaFila: string | null
  /** A declaração acima do teto ainda sem a decisão do usuário. */
  declaracao: { entregaId: string; pedidoMin: number; validoMin: number; motivo: string } | null
}

export interface ScrumPanelSnapshot {
  enabled: boolean
  podeParar: boolean
  /** O caminho do diário; `null` quando não há onde gravar. */
  logFile: string | null
  tiles: { acompanhados: number; cobrancasHoje: number; parados: number }
  contestados: number
  envios: ScrumEnvioView[]
}

export type ScrumPanelResult = { ok: true; snapshot: ScrumPanelSnapshot } | { ok: false; message: string }

// ---------------------------------------------------------------------------
// Aba "Histórico".
// ---------------------------------------------------------------------------

export const SCRUM_HIST_FILTROS = ['tudo', 'cortes', 'contestados', 'cobrancas', 'avisos'] as const
export type ScrumHistFiltro = (typeof SCRUM_HIST_FILTROS)[number]
export const SCRUM_HIST_PERIODOS = ['7d', '30d', 'tudo'] as const
export type ScrumHistPeriodo = (typeof SCRUM_HIST_PERIODOS)[number]

export interface ScrumHistoryRequest {
  filtro: ScrumHistFiltro
  periodo: ScrumHistPeriodo
  busca?: string
  limit?: number
}

export interface ScrumHistoryItem {
  decisao: ScrumDecisao
  /** A contestação do usuário (a última), com a frase dele. */
  contestacao: { frase: string; at: string } | null
  /** O que o agente respondeu a esta decisão. */
  resposta: string | null
}

export type ScrumHistoryResult = { ok: true; items: ScrumHistoryItem[]; total: number } | { ok: false; message: string }

// ---------------------------------------------------------------------------
// Aba "Conversa com o SM": guardada inteira em `<userData>/scrum-chat.jsonl`.
// ---------------------------------------------------------------------------

export interface ScrumChatMessage {
  id: string
  /** ISO. */
  at: string
  role: 'usuario' | 'sm'
  text: string
  /** O id da decisão do diário de que a mensagem trata. */
  sobre: string | null
  projectCwd: string | null
}

export interface ScrumChatHistoryRequest {
  /** Quantas mensagens do fim já estão na tela (a página vem antes delas). */
  skip?: number
  limit?: number
}

export type ScrumChatHistoryResult = { ok: true; messages: ScrumChatMessage[]; hasMore: boolean } | { ok: false; message: string }

export interface ScrumAskRequest {
  text: string
  sobre: string | null
  /** "Marcar como corte errado": contesta `sobre` com o texto (ou "corte errado"). */
  contestar?: boolean
}

/** As mensagens novas (a do usuário e a do SM). */
export type ScrumAskResult = { ok: true; messages: ScrumChatMessage[]; contestado: boolean } | { ok: false; message: string }

export interface ScrumDecideRequest {
  envioId: string
  entregaId: string
  aprovar: boolean
}

export type ScrumActionResult = { ok: true } | { ok: false; message: string }

/** Main → renderer (Channels.scrumChanged): uma linha nova no diário. */
export interface ScrumChangedMsg {
  decisao: ScrumDecisao
}
