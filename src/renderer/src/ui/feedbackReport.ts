/**
 * Texto e link do "Reportar problema / sugerir melhoria". O relato vira uma
 * issue já preenchida no GitHub do projeto (o usuário só confirma lá); o mesmo
 * texto pode ser copiado para mandar por outro canal.
 */
import type { FeedbackDiagnostico } from '@shared/ipc'

export type FeedbackTipo = 'problema' | 'sugestao'

export const ISSUES_URL = 'https://github.com/MatheusLarcher/agent-code/issues/new'
/** Teto do texto que vai no link (o navegador recusa endereços muito longos). */
export const MAX_URL_BODY = 6000

export interface FeedbackInput {
  tipo: FeedbackTipo
  titulo: string
  descricao: string
  diagnostico?: FeedbackDiagnostico | null
}

const PREFIXO: Record<FeedbackTipo, string> = { problema: '[Problema]', sugestao: '[Sugestão]' }

export function feedbackTitle({ tipo, titulo, descricao }: FeedbackInput): string {
  const base = titulo.trim() || descricao.trim().split(/\r?\n/)[0]?.slice(0, 80) || 'Sem título'
  return `${PREFIXO[tipo]} ${base}`
}

export function feedbackBody({ tipo, descricao, diagnostico }: FeedbackInput): string {
  const partes = [`## ${tipo === 'problema' ? 'O que aconteceu' : 'Sugestão'}`, '', descricao.trim() || '(sem descrição)']
  if (diagnostico) {
    partes.push(
      '',
      '## Informações técnicas',
      '',
      `- Versão do Agent Code: ${diagnostico.versao}`,
      `- Sistema: ${diagnostico.sistema}`,
      `- Memória: ${diagnostico.memoriaGb} GB`,
      `- Vídeo (GPU): ${diagnostico.gpu}`
    )
    if (diagnostico.eventosTela.length) {
      partes.push('', '<details><summary>Últimos eventos da tela</summary>', '', '```', ...diagnostico.eventosTela, '```', '</details>')
    }
  }
  return partes.join('\n')
}

/** Link da issue nova. Texto longo demais é cortado (o completo vai copiado). */
export function feedbackIssueUrl(input: FeedbackInput): { url: string; cortado: boolean } {
  let body = feedbackBody(input)
  const cortado = body.length > MAX_URL_BODY
  if (cortado) body = `${body.slice(0, MAX_URL_BODY)}\n\n…(texto cortado: o relato completo foi copiado, cole aqui embaixo)`
  const params = new URLSearchParams({
    title: feedbackTitle(input),
    body,
    labels: input.tipo === 'problema' ? 'bug' : 'enhancement'
  })
  return { url: `${ISSUES_URL}?${params.toString()}`, cortado }
}

/** Texto único para copiar e colar em qualquer lugar. */
export function feedbackPlainText(input: FeedbackInput): string {
  return `${feedbackTitle(input)}\n\n${feedbackBody(input)}`
}
