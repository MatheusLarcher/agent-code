import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { dataHoraTexto, frequenciaTexto, TAREFA_FUSO, type TarefaAgenda, type TarefaVista } from '../../shared/tarefas'
import type { TarefasServico } from './servico'

/**
 * O MCP `avisos` de cada conversa normal: o agente cria e gerencia as tarefas
 * agendadas DESTA conversa (lembrete e monitor) e manda aviso imediato. A tarefa
 * pertence à conversa (`convId` fixo aqui, não vem do modelo). Toda resposta é
 * texto pt-BR que o modelo consegue repassar ao usuário; nada lança.
 */

type Text = { content: { type: 'text'; text: string }[] }
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] })

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- como o próprio SDK tipa a lista de ferramentas.
type AnyTool = SdkMcpToolDefinition<any>
const erase = (definition: unknown): AnyTool => definition as AnyTool

export const MODELO_MONITOR_PADRAO = 'claude-haiku-5-5'

export interface AvisosMcpDeps {
  servico: Pick<TarefasServico, 'criar' | 'vistas' | 'acao' | 'notificarAgora'>
  convId: string
  cwd: string
}

const AGENDA_DOC = `Horário de Brasília (${TAREFA_FUSO}).`

const agendaCampos = {
  intervalo_min: z.number().int().min(1).optional().describe('Repetir a cada N minutos (mínimo 1).'),
  diario_hora: z.string().optional().describe('Repetir todo dia neste horário, "HH:MM" (ex. "09:00").')
}

function agendaDe(input: { quando?: string; intervalo_min?: number; diario_hora?: string }): TarefaAgenda | string {
  const dadas = [input.quando !== undefined, input.intervalo_min !== undefined, input.diario_hora !== undefined].filter(Boolean).length
  if (dadas !== 1) return 'informe exatamente UM entre quando, intervalo_min e diario_hora'
  if (input.quando !== undefined) return { tipo: 'uma-vez', quando: input.quando }
  if (input.intervalo_min !== undefined) return { tipo: 'intervalo', intervaloMin: input.intervalo_min }
  return { tipo: 'diario', hora: input.diario_hora! }
}

export function linhaTarefa(t: TarefaVista, agora = Date.now()): string {
  const proxima = t.proximaEm ? dataHoraTexto(Date.parse(t.proximaEm), agora) : '—'
  const estado = t.estado === 'pausada' ? 'pausada' : t.rodando ? 'checando agora' : 'ativa'
  const ultimo = t.ultimoResultado ? ` · último: ${t.ultimoResultado}${t.ultimoValor ? ` (${t.ultimoValor})` : ''}` : ''
  const modelo = t.tipo === 'monitor' ? ` · modelo ${t.modelo ?? MODELO_MONITOR_PADRAO}` : ''
  return `- ${t.id} [${t.tipo} · ${estado}] ${t.titulo} · ${frequenciaTexto(t.agenda)} · próxima ${proxima}${ultimo}${modelo}`
}

export function buildAvisosTools(deps: AvisosMcpDeps): AnyTool[] {
  const { servico, convId, cwd } = deps
  const listaDaConversa = (): string => {
    const lista = servico.vistas(convId)
    return lista.length ? lista.map((t) => linhaTarefa(t)).join('\n') : 'Nenhuma tarefa agendada nesta conversa.'
  }
  // Depois de pausar/cancelar, o estado DE AGORA (o usuário também mexe pela bolinha):
  // o agente não afirma que uma tarefa "continua ativa" de memória.
  const agoraNaConversa = (): string => `Tarefas desta conversa agora:\n${listaDaConversa()}`
  return [
    erase(tool(
      'aviso_notificar',
      'Mostra um aviso AGORA no Windows (título curto + uma frase); clicar abre esta conversa. Use quando o usuário pedir para ser avisado ao terminar algo ("me avisa quando acabar") — chame no fim do trabalho. Não agenda nada.',
      {
        titulo: z.string().min(1).max(80).describe('Título curto (ex. "Build pronto").'),
        mensagem: z.string().min(1).max(300).describe('Uma frase com o resultado.')
      },
      async ({ titulo, mensagem }) => {
        servico.notificarAgora(convId, titulo, mensagem)
        return text('Aviso enviado.')
      }
    )),
    erase(tool(
      'aviso_lembrete',
      `Agenda um LEMBRETE nesta conversa: no horário aparece um aviso no Windows com a frase (não roda agente nenhum). Uma vez (quando), a cada N minutos ou todo dia às HH:MM. ${AGENDA_DOC} Use para "me lembra de X amanhã às 9h". Para lembrete e aviso agendado use esta ferramenta, nunca CronCreate/ScheduleWakeup (somem quando a sessão acaba). Aparece na bolinha da conversa.`,
      {
        titulo: z.string().min(1).max(160).describe('O que lembrar, curto (vira o título do aviso).'),
        mensagem: z.string().max(500).optional().describe('Detalhe opcional (o texto do aviso).'),
        quando: z.string().optional().describe('Uma vez: data e hora ISO 8601 com fuso, ex. "2026-10-20T09:00:00-03:00".'),
        ...agendaCampos
      },
      async (input) => {
        const agenda = agendaDe(input)
        if (typeof agenda === 'string') return text(`Lembrete não criado: ${agenda}.`)
        const r = servico.criar({ tipo: 'lembrete', titulo: input.titulo, mensagem: input.mensagem, convId, cwd, agenda })
        return text(r.ok ? `Lembrete criado:\n${linhaTarefa(r.valor)}` : `Lembrete não criado: ${r.erro}.`)
      }
    )),
    erase(tool(
      'aviso_monitor',
      `Cria um MONITOR nesta conversa: na frequência pedida, um agente separado (com as ferramentas desta conversa, sem perguntar nada) checa a condição e SÓ avisa quando ela bate — o mesmo valor não avisa de novo. ${AGENDA_DOC} Use para "fica olhando X e me avisa se Y". ANTES de criar, avalie o risco do que cada checagem vai fazer (login, compra, envio, apagar algo, conta de terceiros, custo alto): se houver risco, PERGUNTE ao usuário antes (AskUserQuestion) e registre o combinado em "combinado"; nas rodadas ninguém pergunta. Modelo: escolha ${MODELO_MONITOR_PADRAO} para checagem simples (uma busca, um preço) e claude-sonnet-5-5 para a difícil (vários sites, raciocínio); se o usuário fixar um modelo, use o dele.`,
      {
        titulo: z.string().min(1).max(160).describe('Nome curto do monitor (ex. "Passagem RJ→Lisboa").'),
        condicao: z.string().min(1).max(2000).describe('O que precisa acontecer para avisar, verificável (ex. "preço abaixo de R$ 3.000 no Google Flights, ida 10/12").'),
        ...agendaCampos,
        modelo: z.string().min(1).max(100).optional().describe(`Modelo das rodadas. Padrão: ${MODELO_MONITOR_PADRAO}.`),
        combinado: z.string().max(2000).optional().describe('O que a rodada pode e não pode fazer, combinado com o usuário (ex. "só ler, sem login").'),
        mensagem: z.string().max(500).optional().describe('O que dizer quando bater (opcional).')
      },
      async (input) => {
        const agenda = agendaDe(input)
        if (typeof agenda === 'string') return text(`Monitor não criado: ${agenda}.`)
        const r = servico.criar({
          tipo: 'monitor', titulo: input.titulo, condicao: input.condicao, mensagem: input.mensagem, convId, cwd, agenda,
          modelo: input.modelo ?? MODELO_MONITOR_PADRAO, combinado: input.combinado
        })
        return text(r.ok ? `Monitor criado (a primeira checagem já começa):\n${linhaTarefa(r.valor)}` : `Monitor não criado: ${r.erro}.`)
      }
    )),
    erase(tool(
      'aviso_listar',
      'Lista as tarefas agendadas desta conversa (lembretes e monitores ativos ou pausados): id, frequência, próxima execução e último resultado. Use antes de pausar/cancelar para achar o id.',
      {},
      async () => text(listaDaConversa())
    )),
    erase(tool(
      'aviso_pausar',
      'Pausa (ou retoma, com retomar=true) uma tarefa agendada desta conversa. Pausada não roda nem avisa até retomar.',
      {
        id: z.string().min(1).describe('Id da tarefa (veja aviso_listar).'),
        retomar: z.boolean().optional().describe('true para retomar uma tarefa pausada.')
      },
      async ({ id, retomar }) => {
        const r = servico.acao({ id, acao: retomar ? 'retomar' : 'pausar' }, convId)
        if (!r.ok) return text(`Não deu: ${r.erro}.\n${agoraNaConversa()}`)
        return text(`${r.valor ? `${retomar ? 'Retomada' : 'Pausada'}:\n${linhaTarefa(r.valor)}` : 'Feito.'}\n${agoraNaConversa()}`)
      }
    )),
    erase(tool(
      'aviso_cancelar',
      'Cancela de vez uma tarefa agendada desta conversa: para de rodar e sai da bolinha. Use quando o usuário pedir para parar/cancelar/apagar o lembrete ou monitor.',
      { id: z.string().min(1).describe('Id da tarefa (veja aviso_listar).') },
      async ({ id }) => {
        const r = servico.acao({ id, acao: 'cancelar' }, convId)
        return text(`${r.ok ? 'Tarefa cancelada.' : `Não deu: ${r.erro}.`}\n${agoraNaConversa()}`)
      }
    ))
  ]
}

export function createAvisosMcpServer(deps: AvisosMcpDeps): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({ name: 'avisos', version: '1.0.0', tools: buildAvisosTools(deps) })
}
