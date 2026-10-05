import { randomUUID } from 'node:crypto'
import type { HandoffEnvio } from '../../shared/handoffTracking'
import { isValidEstimativa } from '../../shared/planningEstimate'
import { resolveProjectIdentity } from '../persistence/projectIdentity'
import type { HandoffEnvioCreate, HandoffRepository } from '../persistence/types'
import * as realStore from '../planning/planningStore'

/**
 * O registro no envio do handoff: antes de o primeiro prompt sair para a
 * conversa de implementação, grava um ENVIO por prompt (status `na_fila`) com
 * uma ENTREGA por etapa que o prompt declarou (_handoff/<base>.meta.json).
 *
 * A estimativa de cada entrega é COPIADA do roteiro neste momento — é o prazo
 * prometido. Editar o roteiro depois não muda o que foi gravado. Prompt sem
 * etapas declaradas (antigo, sem o .meta.json) vira envio sem entregas: só tem
 * status de envio, sem prazo.
 *
 * Sem banco gravável, não há o que registrar: devolve [] sem lançar (o envio
 * segue). Erro de verdade (plano sumiu, pasta do projeto sumiu, banco recusou)
 * sobe para quem chamou — o IPC o transforma em `{ ok: false, message }`.
 */

/** Um prompt do envio: o arquivo de _handoff/ e o texto EXATO que vai à conversa. */
export interface HandoffRegisterPrompt {
  arquivo: string
  conteudo: string
}

export interface HandoffRegisterInput {
  projectCwd: string
  slug: string
  conversationId: string
  conversationTitle: string
  /** Na ordem de envio: o 1º sai já, os demais esperam na fila da conversa. */
  prompts: readonly HandoffRegisterPrompt[]
}

/** O que o registro lê do planejamento; injetável nos testes. */
export interface HandoffPlanReader {
  openPlan: typeof realStore.openPlan
  readHandoffEtapas: typeof realStore.readHandoffEtapas
}

export interface HandoffRegisterDeps {
  /**
   * O repositório gravável, ou `null` sem banco. Chamado A CADA registro (e de
   * novo na hora de gravar): o PostgreSQL pode reconectar e trocar a instância.
   * É o mesmo getter do BoardService no index.ts.
   */
  repository(): HandoffRepository | null
  /** Identidade estável do projeto. Padrão: resolveProjectIdentity — o critério do Quadro. */
  projectId?(cwd: string): Promise<string>
  store?: HandoffPlanReader
  /** Id comum aos envios de um mesmo lançamento. */
  newLoteId?(): string
}

async function defaultProjectId(cwd: string): Promise<string> {
  return (await resolveProjectIdentity(cwd)).projectId
}

/** Getter que lança (backend fora do ar no meio da troca) vale como "sem banco". */
function currentRepository(deps: HandoffRegisterDeps): HandoffRepository | null {
  try {
    return deps.repository()
  } catch {
    return null
  }
}

export async function registerHandoffEnvios(
  input: HandoffRegisterInput,
  deps: HandoffRegisterDeps
): Promise<HandoffEnvio[]> {
  if (!currentRepository(deps) || input.prompts.length === 0) return []
  const store = deps.store ?? realStore
  const plan = await store.openPlan(input.projectCwd, input.slug)
  const projectId = await (deps.projectId ?? defaultProjectId)(input.projectCwd)
  if (!projectId) throw new Error('não consegui identificar o projeto (a pasta dele ainda existe?)')

  // Fotografia do roteiro AGORA: título e estimativa de cada etapa.
  const roteiro = new Map(plan.roteiro.etapas.map((e) => [e.id, e]))
  const planTitulo = plan.roteiro.titulo.trim() || input.slug
  const loteId = deps.newLoteId?.() ?? `hl-${randomUUID()}`
  const envios: HandoffEnvioCreate[] = []
  for (const [index, prompt] of input.prompts.entries()) {
    const etapas = (await store.readHandoffEtapas(input.projectCwd, input.slug, prompt.arquivo)) ?? []
    envios.push({
      planSlug: input.slug,
      planTitulo,
      projectId,
      projectCwd: input.projectCwd,
      conversationId: input.conversationId,
      conversationTitle: input.conversationTitle,
      arquivo: prompt.arquivo,
      ordem: index + 1,
      loteId,
      conteudo: prompt.conteudo,
      entregas: etapas.map((etapaId) => {
        // Etapa que sumiu do roteiro depois de o prompt ser gravado: fica com o
        // id como título e sem estimativa (sem prazo), mas continua rastreada.
        const etapa = roteiro.get(etapaId)
        const estimativa = etapa?.estimativa
        return {
          etapaId,
          etapaTitulo: etapa?.titulo.trim() || etapaId,
          estimativaPlano: isValidEstimativa(estimativa) ? estimativa : null
        }
      })
    })
  }
  // Busca de novo: a leitura do disco levou tempo, e o banco pode ter trocado.
  const repository = currentRepository(deps)
  if (!repository) return []
  return repository.createHandoffEnvios(envios)
}
