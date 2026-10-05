import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import {
  tempoAtivoMinutos,
  withinDeadline,
  type HandoffEntrega,
  type HandoffEntregaStatus,
  type HandoffEnvio
} from '../../shared/handoffTracking'
import type { StartAgentOptions } from '../../shared/ipc'
import { MAX_ESTIMATIVA_MIN } from '../../shared/planningEstimate'
import { estimateInputError, type EntregaEstimateDone, type EntregaMiss, type EntregaTimeDone } from './entregaEstimate'
import { activeHandoffTracker } from './handoffRuntime'
import type { HandoffTracker } from './handoffTracker'

/**
 * O servidor MCP `entregas`: a porta pela qual o agente de IMPLEMENTAÇÃO (a
 * conversa nascida de um handoff) declara a própria estimativa de cada etapa e
 * consulta o tempo que o APP mediu (card req-impl-declara-tempo). Molde:
 * tasks/taskTools.ts.
 *
 * - `entrega_estimar` grava a estimativa do agente AO LADO da do plano; o prazo
 *   (estimativa do plano, congelada no envio) nunca muda por aqui.
 * - `entrega_tempo` só lê: é dela que o agente tira o "levou Y min" — o número
 *   nunca sai do texto do chat (modelos erram a própria duração 4–7×).
 *
 * Toda resposta é texto pt-BR legível pelo modelo; falha vira frase, nunca stack
 * trace. Só existe nas sessões de handoff (`entregaServerApplies`).
 */

export const ENTREGAS_MCP_SERVER = 'entregas'
export const ENTREGA_ESTIMAR_TOOL = `mcp__${ENTREGAS_MCP_SERVER}__entrega_estimar`
export const ENTREGA_TEMPO_TOOL = `mcp__${ENTREGAS_MCP_SERVER}__entrega_tempo`
const ENTREGA_TOOLS: ReadonlySet<string> = new Set([ENTREGA_ESTIMAR_TOOL, ENTREGA_TEMPO_TOOL])

/** O que as ferramentas usam do acompanhamento (o HandoffTracker real cumpre). */
export type EntregaTracker = Pick<HandoffTracker, 'estimateEntrega' | 'entregaTime'>

export interface EntregaToolDeps {
  /** A conversa da sessão: o envio corrente é dela, nunca de argumento do modelo. */
  conversationId: string
  /** O acompanhamento ativo, lido a cada chamada. Padrão: handoffRuntime. */
  tracker?: () => EntregaTracker | null
}

/** Quem pode ter o servidor: a conversa de handoff — nunca o Agent Manager
 *  (que troca os servidores) nem a conversa comum. */
export type EntregaSessionRole = Pick<StartAgentOptions, 'planning' | 'handoff'>

export function entregaServerApplies(role: EntregaSessionRole): boolean {
  return Boolean(role.handoff) && !role.planning
}

/** As duas ferramentas, e só na sessão que tem o servidor, passam sem pedir
 *  permissão: gravam só no banco do app (como as mcp__tasks__). Um servidor do
 *  usuário que se chame `entregas` numa conversa comum não ganha o atalho. */
export function entregaToolAutoAllowed(role: EntregaSessionRole, toolName: string): boolean {
  return entregaServerApplies(role) && ENTREGA_TOOLS.has(toolName)
}

type Text = { content: { type: 'text'; text: string }[] }
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] })

const STATUS_LABEL: Record<HandoffEntregaStatus, string> = {
  pendente: 'pendente',
  em_andamento: 'em andamento',
  concluida: 'concluída',
  incompleta: 'incompleta'
}

const OFF =
  'O acompanhamento das entregas não está ativo neste app agora: nada foi registrado nem medido. ' +
  'Siga com a etapa e declare a estimativa e o tempo no texto, como de costume.'

function minutes(n: number): string {
  return `${n} min`
}

/** "Etapa 2 — Título" (N = a posição da etapa NESTE prompt). */
function etapaHeading(entrega: HandoffEntrega): string {
  return `Etapa ${entrega.ordem} — ${entrega.etapaTitulo}`
}

function etapaList(envio: HandoffEnvio): string {
  return envio.entregas.map((e) => `[${e.etapaId}] ${e.etapaTitulo} (${STATUS_LABEL[e.status]})`).join('; ')
}

function prazoPhrase(entrega: HandoffEntrega): string {
  return entrega.estimativaPlano === null ? 'sem estimativa do plano (sem prazo)' : `estimativa do plano ${minutes(entrega.estimativaPlano)} (prazo)`
}

function describeMiss(miss: EntregaMiss): string {
  switch (miss.reason) {
    case 'sem_banco':
      return 'O banco do app está indisponível agora: nada foi registrado nem lido. Siga com a etapa e tente de novo mais tarde.'
    case 'sem_envio':
      return (
        'Esta conversa não tem um envio de handoff registrado no banco (prompt antigo, sem etapas declaradas, ' +
        'ou o registro falhou): não há prazo por etapa a acompanhar. Siga com o trabalho.'
      )
    case 'sem_entregas':
      return `O envio corrente desta conversa (${miss.envio.arquivo}) não declarou etapas: não há prazo por etapa a acompanhar.`
    case 'etapa_fora':
      return (
        `A etapa "${miss.etapa.slice(0, 64)}" não pertence ao envio corrente desta conversa (${miss.envio.arquivo}). ` +
        `Etapas deste envio: ${etapaList(miss.envio)}. Use o id exatamente como está no _roteiro.md.`
      )
    case 'sem_etapa_atual':
      return (
        `Todas as etapas do envio corrente (${miss.envio.arquivo}) estão concluídas. ` +
        `Informe "etapa" para ver o tempo de uma delas: ${etapaList(miss.envio)}.`
      )
  }
}

function describeEstimate(done: EntregaEstimateDone): string {
  const { entrega, envio, anterior } = done
  const z = entrega.estimativaAgente ?? 0
  const lines = [
    `Estimativa registrada para [${entrega.etapaId}] ${entrega.etapaTitulo} (etapa ${entrega.ordem} de ${envio.entregas.length} deste prompt).`,
    entrega.estimativaPlano === null
      ? 'Prazo: nenhum — o plano não estimou esta etapa.'
      : `Prazo (estimativa do plano): ${minutes(entrega.estimativaPlano)} — é ele que vale, e a sua estimativa não o muda.`,
    `Sua estimativa: ${minutes(z)} (motivo: ${entrega.estimativaAgenteMotivo ?? '—'}).`
  ]
  if (anterior) lines.push(`Substituiu a anterior: ${minutes(anterior.minutos)} (motivo: ${anterior.motivo ?? '—'}).`)
  lines.push(
    'O tempo que vale é o tempo ativo medido pelo app; ao concluir a etapa, consulte entrega_tempo com esta etapa.',
    `Escreva agora no chat: ${etapaHeading(entrega)}: ${prazoPhrase(entrega)}, minha estimativa ${minutes(z)}`
  )
  return lines.join('\n')
}

function describeTime(done: EntregaTimeDone): string {
  const { entrega, envio, tempoAtivoMs, contando } = done
  const y = tempoAtivoMinutos(tempoAtivoMs)
  const dentro = withinDeadline(tempoAtivoMs, entrega.estimativaPlano)
  const lines = [
    `[${entrega.etapaId}] ${entrega.etapaTitulo} — etapa ${entrega.ordem} de ${envio.entregas.length} deste prompt, ${STATUS_LABEL[entrega.status]}.`,
    entrega.estimativaPlano === null
      ? 'Prazo: nenhum — o plano não estimou esta etapa.'
      : `Prazo (estimativa do plano): ${minutes(entrega.estimativaPlano)}.`,
    entrega.estimativaAgente === null
      ? 'Sua estimativa: não registrada (registre com entrega_estimar ao começar a etapa).'
      : `Sua estimativa: ${minutes(entrega.estimativaAgente)}.`
  ]
  let medido = `Tempo ativo medido pelo app: ${minutes(y)}`
  if (entrega.estimativaPlano !== null) {
    const pct = Math.round((tempoAtivoMs / (entrega.estimativaPlano * 60_000)) * 100)
    medido += ` (${pct}% do prazo) — ${dentro ? 'dentro do prazo' : `fora do prazo, passou ${minutes(y - entrega.estimativaPlano)}`}`
  }
  lines.push(`${medido}.`)
  if (contando) lines.push('A contagem segue enquanto a etapa está em andamento e você trabalha (pausa quando espera o usuário).')
  if (entrega.retrabalhoMs > 0) lines.push(`Retrabalho depois da conclusão do envio: ${minutes(tempoAtivoMinutos(entrega.retrabalhoMs))}.`)
  const prazo = dentro === null ? 'sem prazo' : dentro ? 'dentro do prazo' : 'fora do prazo'
  lines.push(
    `Ao concluir a etapa, escreva: levou ${minutes(y)} de trabalho (${prazo})` +
      (dentro === false ? ' — e diga por que passou do prazo.' : '')
  )
  return lines.join('\n')
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Mantém a falha dentro da conversa: o modelo lê a frase e segue. */
async function guard(label: string, work: () => Promise<string>): Promise<Text> {
  try {
    return text(await work())
  } catch (error) {
    return text(`${label} falhou: ${errText(error)}. Siga com a etapa; o tempo continua sendo medido pelo app.`)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- como o próprio SDK tipa a lista de ferramentas.
type AnyTool = SdkMcpToolDefinition<any>
const erase = (definition: unknown): AnyTool => definition as AnyTool

export function buildEntregaTools(deps: EntregaToolDeps): AnyTool[] {
  const trackerOf = deps.tracker ?? activeHandoffTracker
  return [
    erase(tool(
      'entrega_estimar',
      'Registra a SUA estimativa (minutos de trabalho seu) para uma etapa do prompt de handoff desta conversa. ' +
        'Chame ao COMEÇAR cada etapa, depois de ler o código dela. Fica ao lado da estimativa do plano, que é o ' +
        'prazo e não muda. Chamar de novo substitui a sua estimativa, guardando o motivo novo.',
      {
        // Sem .max/.int no schema: a recusa do SDK chegaria em inglês; a
        // validação é a de estimateInputError/findEntrega, com a frase em pt-BR.
        etapa: z.string().describe('Id da etapa, exatamente como no _roteiro.md (ex.: "registro-no-banco").'),
        minutos: z.number().describe(`Minutos de trabalho SEU (agente), inteiro de 1 a ${MAX_ESTIMATIVA_MIN}.`),
        motivo: z.string().describe('Por que essa estimativa: o que você viu no código (até 500 caracteres).')
      },
      async (a) =>
        guard('entrega_estimar', async () => {
          const invalid = estimateInputError(a.minutos, a.motivo)
          if (invalid) return `Nada registrado. ${invalid}`
          const tracker = trackerOf()
          if (!tracker) return OFF
          const outcome = await tracker.estimateEntrega(deps.conversationId, { etapa: a.etapa, minutos: a.minutos, motivo: a.motivo })
          return outcome.ok ? describeEstimate(outcome) : `Nada registrado. ${describeMiss(outcome)}`
        })
    )),

    erase(tool(
      'entrega_tempo',
      'Mostra, pela MEDIÇÃO DO APP, o prazo (estimativa do plano), a sua estimativa e o tempo ativo já trabalhado ' +
        'de uma etapa do prompt de handoff desta conversa. Use ao CONCLUIR cada etapa (informe a etapa) para ' +
        'escrever "levou Y min de trabalho (dentro/fora do prazo)" — nunca estime o tempo de cabeça. Só leitura.',
      {
        etapa: z
          .string()
          .optional()
          .describe('Id da etapa, como no _roteiro.md. Sem ele: a etapa em andamento (ou a primeira não concluída).')
      },
      async (a) =>
        guard('entrega_tempo', async () => {
          const tracker = trackerOf()
          if (!tracker) return OFF
          const etapa = a.etapa?.trim() ? a.etapa : null
          const outcome = await tracker.entregaTime(deps.conversationId, etapa)
          return outcome.ok ? describeTime(outcome) : describeMiss(outcome)
        })
    ))
  ]
}

export function createEntregaMcpServer(deps: EntregaToolDeps): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({ name: ENTREGAS_MCP_SERVER, version: '1.0.0', tools: buildEntregaTools(deps) })
}

/** O servidor da sessão, ou `null` quando ela não é uma conversa de handoff. */
export function entregaMcpServerFor(
  role: EntregaSessionRole & Pick<StartAgentOptions, 'convId'>,
  deps: Omit<EntregaToolDeps, 'conversationId'> = {}
): ReturnType<typeof createSdkMcpServer> | null {
  return entregaServerApplies(role) ? createEntregaMcpServer({ ...deps, conversationId: role.convId }) : null
}
