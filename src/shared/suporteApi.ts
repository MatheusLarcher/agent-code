// A parte do suporte remoto na `window.api` (preload → suporteRemoto/canais.ts no main).
// A chave da equipe só vai da tela para o main: nenhuma destas chamadas a devolve.
import type { SuporteAjustes, SuporteAjustesPatch, SuporteStatus } from './suporteRemoto'

export type SuporteResultadoAjustes = { ok: true; ajustes: SuporteAjustes } | { ok: false; mensagem: string }

/** `avisado`: a falha já virou aviso do estado (o cliente recusou) e a tela mostra em toast. */
export type SuporteResultadoConectar = { ok: true } | { ok: false; mensagem: string; avisado?: boolean }

export interface SuporteApi {
  /** Ajustes de Configurações > Suporte Remoto (sem a chave: só `temChave`). */
  getSuporteAjustes(): Promise<SuporteAjustes>
  /** Salva interruptor, nome e/ou chave; o main valida e recusa com a mensagem. */
  salvarSuporteAjustes(patch: SuporteAjustesPatch): Promise<SuporteResultadoAjustes>
  onSuporteAjustesMudou(cb: (ajustes: SuporteAjustes) => void): () => void
  /** Estado da sessão de suporte (uma por vez no app). */
  getSuporteStatus(): Promise<SuporteStatus>
  onSuporteStatusMudou(cb: (status: SuporteStatus) => void): () => void
  /** Conecta a conversa ao cliente do código; resolve quando o cliente decide. */
  conectarSuporte(convId: string, codigo: string): Promise<SuporteResultadoConectar>
  /** Encerra a sessão, desiste do pedido em aberto ou dispensa o aviso de queda. */
  desconectarSuporte(): Promise<boolean>
}
