/**
 * Quem manda na TV (amb-tv-prioridade) — PURO.
 *
 *   1. o mockup de um agente chamando (o chamado mais antigo);
 *   2. o teste ao vivo — com chamado ativo, vai para o quadrinho (PiP);
 *   3. o planejamento em andamento (Fase 3);
 *   4. o último HTML criado (por HTML_SHOW_MS);
 *   5. o placar: tarefas do quadro, energia e quem está trabalhando.
 *
 * Com filtro de projeto, só contam os itens dele (`keep`). `waiting` é a fila
 * da sala que não está na tela ("+N esperando"). Com o usuário em foco na TV
 * quem chama congela o que está na tela (Projectors.lock): nada aqui decide isso.
 */
import type { HtmlWrite } from './agentHtml'
import type { OfficeCall } from './officeCalls'
import type { DeviceUse } from './projectorUse'

export type TvMain =
  | { kind: 'call'; call: OfficeCall }
  | { kind: 'test'; use: DeviceUse }
  | { kind: 'html'; write: HtmlWrite }
  | { kind: 'score' }

export interface TvAgenda {
  main: TvMain
  /** O teste ao vivo no canto, quando a tela é de um chamado. */
  pip: DeviceUse | null
  /** Quantos esperam a vez (chamados e testes fora da tela). */
  waiting: number
}

export const SCORE: TvAgenda = { main: { kind: 'score' }, pip: null, waiting: 0 }

export function tvAgenda(
  calls: readonly OfficeCall[],
  tests: readonly DeviceUse[],
  html: HtmlWrite | null,
  keep: (convId: string) => boolean = () => true
): TvAgenda {
  const c = calls.filter((x) => keep(x.convId))
  const t = tests.filter((x) => keep(x.convId))
  if (c.length) return { main: { kind: 'call', call: c[0] }, pip: t[0] ?? null, waiting: c.length - 1 + Math.max(0, t.length - 1) }
  if (t.length) return { main: { kind: 'test', use: t[0] }, pip: null, waiting: t.length - 1 }
  if (html && keep(html.convId)) return { main: { kind: 'html', write: html }, pip: null, waiting: 0 }
  return SCORE
}

/** O que está na tela, em texto (mudou = redesenha). */
export function agendaSig(a: TvAgenda): string {
  const m = a.main
  const id = m.kind === 'call' ? m.call.id : m.kind === 'test' ? m.use.key : m.kind === 'html' ? m.write.id : ''
  return `${m.kind}:${id}|${a.pip?.key ?? ''}|${a.waiting}`
}

/** A conversa do que está na tela (o clique e o foco usam); null no placar. */
export function agendaConv(a: TvAgenda): string | null {
  const m = a.main
  return m.kind === 'call' ? m.call.convId : m.kind === 'test' ? m.use.convId : m.kind === 'html' ? m.write.convId : null
}
