import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { MAX_ESTIMATIVA_MIN } from '../../shared/planningEstimate'
import { STAGE_STATUSES, type Roteiro, type RoteiroStage, type StageStatus } from './planningModel'
import { RoteiroConflictError, type OpenedPlan, type RoteiroDraft } from './planningStore'
import { Body, erase, guard, Name, Title, type AnyTool } from './planningToolKit'
import { estimativaText, etapaLines, text, totalEstimativaText } from './planningToolText'

/**
 * As ferramentas plan_* do roteiro e do handoff, fora de planningTools.ts (que
 * as registra, na ordem de PLANNING_TOOL_NAMES, e cujas regras valem aqui):
 * - plan_roteiro_set: a lista ordenada de etapas, com a estimativa de cada uma
 *   em minutos de trabalho do agente. Status e estimativa omitidos ficam como
 *   estão; estimativa null remove.
 * - plan_etapa_marcar: o status de uma etapa (a estimativa vai junto, intacta).
 * - plan_handoff_write: o prompt e as etapas do roteiro que ele cobre.
 */

export interface RoteiroToolDeps {
  open: () => Promise<OpenedPlan>
  saveRoteiro: (roteiro: RoteiroDraft, expectedRev: number) => Promise<Roteiro>
  /** Grava o prompt em _handoff/ com as etapas que ele cobre; devolve o caminho do .md. */
  writeHandoff: (conteudo: string, etapas: readonly string[]) => Promise<string>
  changed: () => void
}

export interface RoteiroTools {
  roteiroSet: AnyTool
  etapaMarcar: AnyTool
  handoffWrite: AnyTool
}

const EtapaInput = z.object({
  id: Name.describe('Id curto e estável da etapa (ex.: "requisitos", "etapa-2"). Cards apontam para ele.'),
  titulo: Title.describe('O que esta etapa entrega, em uma frase.'),
  status: z.enum(STAGE_STATUSES).optional().describe('pendente | em_andamento | concluida.'),
  estimativa: z
    .number()
    .int()
    .min(1)
    .max(MAX_ESTIMATIVA_MIN)
    .nullable()
    .optional()
    .describe(
      `Minutos de trabalho do AGENTE de implementação (não de um desenvolvedor humano), inteiro de 1 a ${MAX_ESTIMATIVA_MIN}. ` +
        'Omitida, mantém a estimativa atual da etapa; null remove.'
    )
})

/** A lista nova de etapas: status e estimativa omitidos vêm da etapa que já existia. */
function nextEtapas(current: readonly RoteiroStage[], input: readonly z.infer<typeof EtapaInput>[]): RoteiroStage[] {
  const before = new Map(current.map((e) => [e.id, e]))
  return input.map((e) => {
    const prev = before.get(e.id)
    const next: RoteiroStage = { id: e.id, titulo: e.titulo.trim(), status: e.status ?? prev?.status ?? 'pendente' }
    const estimativa = e.estimativa === undefined ? prev?.estimativa : e.estimativa
    if (estimativa != null) next.estimativa = estimativa
    return next
  })
}

/** O roteiro com a etapa `id` em `status`, ou o motivo (texto) de não haver o que gravar. */
function markEtapa(roteiro: Roteiro, id: string, status: StageStatus): Roteiro | string {
  const etapa = roteiro.etapas.find((e) => e.id === id)
  if (!etapa) {
    const ids = roteiro.etapas.map((e) => e.id).join(', ') || 'nenhuma'
    return `Não existe etapa ${id} no roteiro (etapas: ${ids}).`
  }
  if (etapa.status === status) return `A etapa ${id} já estava [${status}]; nada gravado.`
  return { ...roteiro, etapas: roteiro.etapas.map((e) => (e.id === id ? { ...e, status } : e)) }
}

/** Por que as `etapas` de um prompt de handoff não servem, ou null. */
function handoffEtapasProblem(roteiro: Roteiro, etapas: readonly string[]): string | null {
  const repetidas = [...new Set(etapas.filter((id, i) => etapas.indexOf(id) !== i))]
  if (repetidas.length) return `etapa repetida em "etapas": ${repetidas.join(', ')}.`
  const ids = roteiro.etapas.map((e) => e.id)
  const fora = etapas.filter((id) => !ids.includes(id))
  if (fora.length) return `etapas que não estão no roteiro: ${fora.join(', ')} (etapas: ${ids.join(', ') || 'nenhuma'}).`
  return null
}

export function buildRoteiroTools(deps: RoteiroToolDeps): RoteiroTools {
  const { open, changed } = deps
  return {
    roteiroSet: erase(tool(
      'plan_roteiro_set',
      'Substitui a lista ORDENADA de etapas do roteiro. Mande a lista inteira, na ordem em que devem acontecer. Etapa que já existia mantém o status se você não informar outro; etapa nova nasce "pendente". Cada etapa leva "estimativa": minutos de trabalho do agente de implementação; omitida, a etapa mantém a estimativa atual, e null remove. A resposta lista as estimativas e o total. Não mexe no título do planejamento: ele é do usuário e do app, não há campo para ele e o atual é sempre preservado. Se o roteiro mudar no meio (ex.: o usuário marcou uma etapa na tela), nada é gravado e a resposta traz o roteiro atual para você refazer.',
      { etapas: z.array(EtapaInput).max(500).describe('Todas as etapas, na ordem.') },
      async (a) =>
        guard('plan_roteiro_set', async () => {
          const plan = await open()
          const etapas = nextEtapas(plan.roteiro.etapas, a.etapas)
          // O título é o que está em disco (o Manager não o altera). Com o rev
          // lido agora: se a tela mexeu no meio — inclusive no título —, nada é
          // gravado e o modelo recebe o roteiro atual para refazer (describeError).
          const saved = await deps.saveRoteiro({ titulo: plan.roteiro.titulo, etapas }, plan.roteiro.rev)
          changed()
          const ids = new Set(saved.etapas.map((e) => e.id))
          const orphans = plan.cards.filter((c) => c.etapa && !ids.has(c.etapa)).map((c) => c.id)
          const lines = [`Roteiro gravado (${saved.etapas.length} etapas):`, ...etapaLines(saved.etapas)]
          if (saved.etapas.length) lines.push(`Estimativa total do roteiro: ${totalEstimativaText(saved.etapas)}.`)
          if (orphans.length) {
            lines.push(`Atenção: estes cards apontam para etapas que saíram do roteiro: ${orphans.join(', ')}. Ajuste com plan_card_update.`)
          }
          return text(lines.join('\n'))
        })
    )),

    etapaMarcar: erase(tool(
      'plan_etapa_marcar',
      'Muda o status de UMA etapa do roteiro (pendente, em_andamento, concluida).',
      { id: Name.describe('Id da etapa.'), status: z.enum(STAGE_STATUSES).describe('Novo status.') },
      async (a) =>
        guard('plan_etapa_marcar', async () => {
          const plan = await open()
          const next = markEtapa(plan.roteiro, a.id, a.status)
          if (typeof next === 'string') return text(next)
          try {
            await deps.saveRoteiro(next, plan.roteiro.rev)
          } catch (error) {
            if (!(error instanceof RoteiroConflictError)) throw error
            // Mudou no meio (a tela marcou outra etapa?). É um campo só: reaplica
            // UMA vez sobre o roteiro atual; outro conflito vira texto (guard).
            const retry = markEtapa(error.current, a.id, a.status)
            if (typeof retry === 'string') return text(`O roteiro mudou enquanto você marcava. ${retry}`)
            await deps.saveRoteiro(retry, error.current.rev)
          }
          changed()
          return text(`Etapa ${a.id} agora está [${a.status}].`)
        })
    )),

    handoffWrite: erase(tool(
      'plan_handoff_write',
      'Grava o prompt de handoff (o que a conversa de implementação vai receber) em _handoff/AAAA-MM-DD-NN.md do planejamento e devolve o caminho. Em "etapas", informe os ids das etapas do roteiro que ESTE prompt cobre, na ordem: elas ficam num arquivo ao lado (não no texto) e é por elas que o app acompanha a entrega e o prazo de cada etapa. Não inicia nada: só registra.',
      {
        conteudo: Body.min(1).describe('O prompt completo de handoff, em markdown.'),
        etapas: z
          .array(Name)
          .min(1)
          .max(100)
          .describe('Ids das etapas do roteiro que este prompt cobre, na ordem, sem repetir. Obrigatório.')
      },
      async (a) =>
        guard('plan_handoff_write', async () => {
          const plan = await open()
          const problem = handoffEtapasProblem(plan.roteiro, a.etapas)
          if (problem) return text(`Handoff não gravado: ${problem}`)
          const file = await deps.writeHandoff(a.conteudo, a.etapas)
          changed()
          const byId = new Map(plan.roteiro.etapas.map((e) => [e.id, e]))
          const etapas = a.etapas.flatMap((id) => byId.get(id) ?? [])
          const lista = etapas.map((e) => `${e.id} (${estimativaText(e)})`).join(', ')
          return text(
            `Handoff gravado em ${file}\n` +
              `Etapas deste prompt (${etapas.length}): ${lista}. Estimativa total do prompt: ${totalEstimativaText(etapas)}.`
          )
        })
    ))
  }
}
