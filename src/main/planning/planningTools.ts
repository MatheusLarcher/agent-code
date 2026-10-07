import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { notifyPlanningChanged, type PlanningChangeNotice } from './planningEvents'
import { FONTE_RULE_TEXT, isValidFonte } from '../../shared/planningFonte'
import * as realMedia from './planningMedia'
import { anexosCheck, importAndAttach, loadMediaIndex, readCardWithMedia } from './planningMediaTools'
import type { MediaToolDeps, PlanningToolMedia } from './planningMediaTools'
import { CARD_TYPES, type CardType, type PlanCard } from './planningModel'
import { buildRoteiroTools } from './planningRoteiroTools'
import { discardStaleHandoffs, findStaleHandoffs } from './handoffStale'
import * as realStore from './planningStore'
import { RevConflictError, type OpenedPlan } from './planningStore'
import { Body, erase, guard, Name, Title, type AnyTool } from './planningToolKit'
import { cardHeader, describePlan, text, type ToolText as Text } from './planningToolText'

/**
 * O servidor MCP `planning`: as ferramentas com que o Agent Manager lê e altera
 * o planejamento da sessão (a pasta dele é a de planDirPath, na pasta de dados
 * do app). Mesmo molde de taskTools.ts.
 *
 * - O planejamento (projectCwd + slug) vem do contexto da sessão, NUNCA de
 *   argumento: o Manager não consegue apontar outro planejamento nem outra pasta.
 * - Toda gravação passa pelo planningStore (validação, rev otimista, registro
 *   de gravação própria). Nada aqui toca o disco direto.
 * - Toda gravação bem-sucedida chama `notify`, porque o vigia ignora gravações
 *   próprias e a tela aberta precisa recarregar.
 * - Toda resposta é texto em pt-BR: falha vira frase que o modelo consegue agir
 *   em cima (ex.: conflito de rev devolve o card atual), nunca stack trace.
 * - O roteiro também tem rev: as ferramentas gravam com o rev que acabaram de
 *   ler; plan_etapa_marcar reaplica UMA vez em conflito (é um campo só), e
 *   plan_roteiro_set devolve o roteiro atual para o modelo refazer.
 * - O título do planejamento é do usuário e do app: plan_roteiro_set não tem
 *   campo de título e regrava sempre o título lido do disco.
 * - Mídia (anexos, blocos de imagem no plan_read, plan_midia_importar) mora
 *   em planningMediaTools.ts; roteiro (com a estimativa das etapas) e handoff
 *   (com as etapas de cada prompt), em planningRoteiroTools.ts.
 */

export const PLANNING_MCP_SERVER = 'planning'

export const PLANNING_TOOL_NAMES = [
  'plan_read',
  'plan_roteiro_set',
  'plan_etapa_marcar',
  'plan_card_create',
  'plan_card_update',
  'plan_card_delete',
  'plan_card_link',
  'plan_ambiguidade_abrir',
  'plan_ambiguidade_resolver',
  'plan_handoff_write',
  'plan_handoff_limpar',
  'plan_midia_importar'
] as const

export type PlanningToolStore = Pick<
  typeof realStore,
  'openPlan' | 'saveCard' | 'deleteCard' | 'saveRoteiro' | 'writeHandoff'
>

export interface PlanningToolContext {
  projectCwd: string
  slug: string
  /** Injetável para teste; ausente, o planningStore real. */
  store?: PlanningToolStore
  /** Mídia do plano (listar, ler, importar); injetável para teste, ausente, o planningMedia real. */
  media?: PlanningToolMedia
  /** Aviso à tela depois de cada gravação; ausente, notifyPlanningChanged. */
  notify?: (change: PlanningChangeNotice) => void
  /** Relógio (data da decisão e numeração do handoff); ausente, agora. */
  now?: () => Date
}

const Rev = z.number().int().min(0)
const Anexos = z.array(z.string().max(200)).max(100)

/** As duas formas de fonte aceitas, para a descrição do parâmetro "fonte". */
const FONTE_FORMAS =
  'a URL http/https de onde a informação saiu (documentação, artigo, issue) ou, quando vier da análise do código, ' +
  'o caminho de um arquivo do projeto, relativo à raiz, com ":linha" opcional (ex.: src/x.ts:12)'

/** Recusa de sugestão sem fonte válida: a regra ÚNICA (src/shared/planningFonte),
 *  a mesma do store e da tela, e onde buscar uma fonte. */
const SUGESTAO_SEM_FONTE =
  `card do tipo "sugestao" exige fonte verificável em "fonte": ${FONTE_RULE_TEXT}. ` +
  'Pesquise com WebSearch/WebFetch ou localize o trecho com Read/Grep; sugestão sem fonte verificável não entra no planejamento.'

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
    .replace(/-+$/, '')
}

function withNewline(corpo: string): string {
  return corpo && !corpo.endsWith('\n') ? `${corpo}\n` : corpo
}

function isoDay(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** Motivo de recusa de um card que o store aceitaria, mas que deixaria o plano incoerente. */
function coherenceProblem(plan: OpenedPlan, card: PlanCard, selfId?: string): string | null {
  if (card.tipo === 'sugestao' && !isValidFonte(card.fonte)) return SUGESTAO_SEM_FONTE
  if (card.tipo === 'midia' && !card.anexos?.length) {
    return 'card do tipo "midia" precisa de pelo menos um anexo em "anexos" (traga o arquivo com plan_midia_importar).'
  }
  const etapas = plan.roteiro.etapas.map((e) => e.id)
  if (card.etapa && !etapas.includes(card.etapa)) {
    return `a etapa "${card.etapa}" não está no roteiro (etapas: ${etapas.join(', ') || 'nenhuma'}).`
  }
  const ids = new Set(plan.cards.map((c) => c.id))
  if (selfId && card.links.includes(selfId)) return 'um card não pode apontar para ele mesmo.'
  const missing = card.links.filter((id) => !ids.has(id))
  if (missing.length) return `links para cards que não existem: ${missing.join(', ')}.`
  return null
}

export function buildPlanningTools(ctx: PlanningToolContext): AnyTool[] {
  const store = ctx.store ?? realStore
  const { projectCwd, slug } = ctx
  const notify = ctx.notify ?? notifyPlanningChanged
  const now = ctx.now ?? (() => new Date())
  const open = (): Promise<OpenedPlan> => store.openPlan(projectCwd, slug)
  const changed = (): void => notify({ projectCwd, slug })
  const find = (plan: OpenedPlan, id: string): PlanCard | undefined => plan.cards.find((c) => c.id === id)
  const mediaDeps: MediaToolDeps = {
    projectCwd,
    slug,
    media: ctx.media ?? realMedia,
    open,
    saveCard: (card, expectedRev) => store.saveCard(projectCwd, slug, card, expectedRev),
    changed
  }
  const roteiroTools = buildRoteiroTools({
    open,
    saveRoteiro: (roteiro, expectedRev) => store.saveRoteiro(projectCwd, slug, roteiro, expectedRev),
    writeHandoff: (conteudo, etapas) => store.writeHandoff(projectCwd, slug, conteudo, now(), etapas),
    staleHandoffs: async () => (await findStaleHandoffs(projectCwd, slug)).stale.map((h) => h.name),
    discardStaleHandoffs: () => discardStaleHandoffs(projectCwd, slug),
    changed
  })

  /** Grava um card novo (rev 0). Sem id explícito, deriva um livre de tipo + título. */
  async function createCard(plan: OpenedPlan, draft: PlanCard, explicitId: boolean): Promise<Text> {
    const problem = coherenceProblem(plan, draft, explicitId ? draft.id : undefined)
    if (problem) return text(`Card não criado: ${problem}`)
    if (explicitId) {
      try {
        const saved = await store.saveCard(projectCwd, slug, draft, 0)
        changed()
        return text(`Card criado: ${cardHeader(saved)}`)
      } catch (error) {
        if (!(error instanceof RevConflictError) || !error.current) throw error
        return text(
          `Card não criado: já existe o card ${draft.id} (rev ${error.current.rev}). Para alterá-lo, use ` +
            `plan_card_update com expected_rev=${error.current.rev}; para um card novo, escolha outro id.`
        )
      }
    }
    const taken = new Set([...plan.cards.map((c) => c.id), ...plan.invalid.map((f) => f.file.replace(/^cards\/|\.md$/g, ''))])
    const base = slugify(`${draft.tipo}-${draft.titulo}`) || draft.tipo
    for (let n = 1; n <= 100; n++) {
      const id = n === 1 ? base : `${base}-${n}`
      if (taken.has(id)) continue
      try {
        const saved = await store.saveCard(projectCwd, slug, { ...draft, id }, 0)
        changed()
        return text(`Card criado: ${cardHeader(saved)}`)
      } catch (error) {
        // Alguém criou o mesmo id entre a leitura e a gravação: tenta o próximo.
        if (!(error instanceof RevConflictError)) throw error
        taken.add(id)
      }
    }
    return text('Card não criado: não achei id livre a partir do título; informe "id" explicitamente.')
  }

  function draftCard(a: Omit<Partial<PlanCard>, 'rev'> & { tipo: CardType; titulo: string }): PlanCard {
    const card: PlanCard = {
      id: a.id ?? 'novo',
      tipo: a.tipo,
      titulo: a.titulo.trim(),
      links: [...new Set(a.links ?? [])],
      rev: 0,
      corpo: withNewline(a.corpo ?? '')
    }
    if (a.etapa) card.etapa = a.etapa
    const status = a.status ?? (a.tipo === 'ambiguidade' ? 'aberta' : undefined)
    if (status) card.status = status
    if (a.fonte) card.fonte = a.fonte
    if (a.anexos?.length) card.anexos = [...new Set(a.anexos)]
    return card
  }

  return [
    erase(tool(
      'plan_read',
      'Lê o planejamento desta sessão: o roteiro (etapas na ordem, com status e estimativa, e o total estimado), os cards resumidos e os arquivos inválidos. Cada card aparece com o título em destaque, [[Título]] — o nome com que o usuário o cita —, seguido de id, tipo, etapa, status, links, rev e um trecho do corpo; os anexos vêm abaixo dele como [Tipo] nome — caminho absoluto, e o texto termina com "Mídias do plano" (todas as de midia/, inclusive as sem card). Informe card_id para ler um card inteiro — é de onde vem o rev para alterá-lo; as imagens anexadas a ele (png, jpeg, gif, webp; até 4, cada uma até 5 MB) vêm também como imagem.',
      { card_id: Name.optional().describe('Id de um card para ler por inteiro.') },
      async (a) =>
        guard('plan_read', async () => {
          const plan = await open()
          const index = await loadMediaIndex(mediaDeps, plan)
          if (!a.card_id) return text(describePlan(plan, index))
          const card = find(plan, a.card_id)
          if (!card) return text(`Não existe card ${a.card_id} neste planejamento; veja plan_read.`)
          return readCardWithMedia(mediaDeps, card, index)
        })
    )),

    roteiroTools.roteiroSet,
    roteiroTools.etapaMarcar,

    erase(tool(
      'plan_card_create',
      'Cria um card no planejamento. Tipos: etapa, requisito, decisao, sugestao (EXIGE fonte: URL ou arquivo do projeto), ambiguidade (prefira plan_ambiguidade_abrir), nota, midia (EXIGE anexos: um card feito só de arquivos). Para citar outro card no corpo, use o título dele: [[Título do card]] — vira seta no canvas; "links" (ids) são as ligações que a tela desenha.',
      {
        id: Name.optional().describe('Id do card. Omitido, é derivado do tipo e do título.'),
        tipo: z.enum(CARD_TYPES).describe('Tipo do card.'),
        titulo: Title.describe('Título curto.'),
        etapa: Name.optional().describe('Id da etapa do roteiro a que o card pertence.'),
        status: z.string().max(64).optional().describe('Status livre (em ambiguidade: aberta | resolvida).'),
        links: z.array(Name).max(1000).optional().describe('Ids de cards existentes a ligar a este.'),
        fonte: z.string().max(4096).optional().describe(`De onde a informação saiu (obrigatória em sugestao): ${FONTE_FORMAS}.`),
        anexos: Anexos.optional().describe('Nomes de arquivos em midia/ (como plan_read e plan_midia_importar mostram). Obrigatório em midia.'),
        corpo: Body.optional().describe('Conteúdo em markdown.')
      },
      async (a) =>
        guard('plan_card_create', async () => {
          if (a.tipo === 'sugestao' && !isValidFonte(a.fonte)) return text(`Card não criado: ${SUGESTAO_SEM_FONTE}`)
          const plan = await open()
          const problem = await anexosCheck(mediaDeps, plan, a.anexos)
          if (problem) return text(`Card não criado: ${problem}`)
          return createCard(plan, draftCard(a), a.id !== undefined)
        })
    )),

    erase(tool(
      'plan_card_update',
      'Altera um card existente. Exige expected_rev (o rev que você leu): se o card mudou desde então, nada é gravado e a resposta traz a versão atual. Campos omitidos ficam como estão; null em etapa/status/fonte remove o campo; anexos: [] tira todos os anexos.',
      {
        id: Name.describe('Id do card.'),
        expected_rev: Rev.describe('Rev do card na sua última leitura.'),
        tipo: z.enum(CARD_TYPES).optional(),
        titulo: Title.optional(),
        etapa: Name.nullable().optional(),
        status: z.string().max(64).nullable().optional(),
        links: z.array(Name).max(1000).optional().describe('Substitui a lista inteira de links.'),
        fonte: z.string().max(4096).nullable().optional(),
        anexos: Anexos.optional().describe('Substitui a lista inteira de anexos (nomes em midia/); [] tira todos.'),
        corpo: Body.optional().describe('Substitui o corpo inteiro.')
      },
      async (a) =>
        guard('plan_card_update', async () => {
          const plan = await open()
          const current = find(plan, a.id)
          if (!current) return text(`Não existe card ${a.id}; para criar, use plan_card_create.`)
          if (current.rev !== a.expected_rev) throw new RevConflictError(current, a.expected_rev)
          const next: PlanCard = { ...current }
          if (a.tipo !== undefined) next.tipo = a.tipo
          if (a.titulo !== undefined) next.titulo = a.titulo.trim()
          if (a.links !== undefined) next.links = [...new Set(a.links)]
          if (a.corpo !== undefined) next.corpo = withNewline(a.corpo)
          if (a.anexos !== undefined) {
            const anexosError = await anexosCheck(mediaDeps, plan, a.anexos, current)
            if (anexosError) return text(`Card não alterado: ${anexosError}`)
            if (a.anexos.length) next.anexos = [...new Set(a.anexos)]
            else delete next.anexos
          }
          for (const key of ['etapa', 'status', 'fonte'] as const) {
            const value = a[key]
            if (value === null) delete next[key]
            else if (value !== undefined) next[key] = value
          }
          if (next.tipo === 'ambiguidade' && !next.status) next.status = 'aberta'
          const problem = coherenceProblem(plan, next, next.id)
          if (problem) return text(`Card não alterado: ${problem}`)
          const saved = await store.saveCard(projectCwd, slug, next, a.expected_rev)
          changed()
          return text(`Card atualizado: ${cardHeader(saved)}`)
        })
    )),

    erase(tool(
      'plan_card_delete',
      'Apaga um card. Exige expected_rev: se o card mudou desde a sua leitura, nada é apagado.',
      { id: Name.describe('Id do card.'), expected_rev: Rev.describe('Rev do card na sua última leitura.') },
      async (a) =>
        guard('plan_card_delete', async () => {
          const plan = await open()
          const referrers = plan.cards.filter((c) => c.id !== a.id && c.links.includes(a.id)).map((c) => c.id)
          await store.deleteCard(projectCwd, slug, a.id, a.expected_rev)
          changed()
          const tail = referrers.length
            ? ` Estes cards ainda apontam para ele: ${referrers.join(', ')} — remova com plan_card_link (acao "remover").`
            : ''
          return text(`Card ${a.id} apagado.${tail}`)
        })
    )),

    erase(tool(
      'plan_card_link',
      'Adiciona ou remove a ligação de um card (de) para outro (para). A ligação fica gravada no card de origem.',
      {
        de: Name.describe('Id do card de origem.'),
        para: Name.describe('Id do card de destino.'),
        acao: z.enum(['adicionar', 'remover']).optional().describe('Padrão: adicionar.'),
        expected_rev: Rev.optional().describe('Rev do card de origem. Omitido, vale o rev lido agora.')
      },
      async (a) =>
        guard('plan_card_link', async () => {
          const plan = await open()
          const source = find(plan, a.de)
          if (!source) return text(`Não existe card ${a.de}.`)
          const remove = a.acao === 'remover'
          if (!remove && a.de === a.para) return text('Um card não pode apontar para ele mesmo.')
          if (!remove && !find(plan, a.para)) return text(`Não existe card ${a.para} para ligar.`)
          const has = source.links.includes(a.para)
          if (has !== remove) {
            return text(remove ? `${a.de} não aponta para ${a.para}; nada gravado.` : `${a.de} já aponta para ${a.para}; nada gravado.`)
          }
          const expected = a.expected_rev ?? source.rev
          if (expected !== source.rev) throw new RevConflictError(source, expected)
          const links = remove ? source.links.filter((id) => id !== a.para) : [...source.links, a.para]
          const saved = await store.saveCard(projectCwd, slug, { ...source, links }, expected)
          changed()
          return text(`${remove ? 'Ligação removida' : 'Ligação criada'}: ${cardHeader(saved)}`)
        })
    )),

    erase(tool(
      'plan_ambiguidade_abrir',
      'Registra uma AMBIGUIDADE: um ponto em que o pedido admite leituras diferentes e a escolha muda o resultado. Cria um card tipo ambiguidade, status aberta, ligado aos cards envolvidos, com a sua opinião sobre qual leitura seguir e por quê.',
      {
        id: Name.optional().describe('Id do card. Omitido, é derivado do título.'),
        titulo: Title.describe('A pergunta em aberto, curta.'),
        contexto: Body.min(1).describe('O que está ambíguo e quais as leituras possíveis.'),
        opiniao: Body.min(1).describe('Sua opinião: qual leitura seguir e por quê.'),
        envolvidos: z.array(Name).max(50).optional().describe('Ids dos cards afetados pela ambiguidade.'),
        etapa: Name.optional().describe('Id da etapa do roteiro onde a dúvida surgiu.')
      },
      async (a) =>
        guard('plan_ambiguidade_abrir', async () => {
          const plan = await open()
          const envolvidos = [...new Set(a.envolvidos ?? [])]
          // Citados pelo título, [[Título]], como o usuário e o canvas os nomeiam.
          const lista = envolvidos.map((id) => `- [[${find(plan, id)?.titulo ?? id}]]`)
          const corpo = [
            '## O que está ambíguo',
            '',
            a.contexto.trim(),
            '',
            '## Cards envolvidos',
            '',
            ...(lista.length ? lista : ['(nenhum card específico)']),
            '',
            '## Opinião do Manager',
            '',
            a.opiniao.trim()
          ].join('\n')
          const draft = draftCard({ id: a.id, tipo: 'ambiguidade', titulo: a.titulo, etapa: a.etapa, status: 'aberta', links: envolvidos, corpo })
          return createCard(plan, draft, a.id !== undefined)
        })
    )),

    erase(tool(
      'plan_ambiguidade_resolver',
      'Resolve uma ambiguidade aberta: status "resolvida" e a decisão registrada no corpo do card, com a data. Exige expected_rev.',
      {
        id: Name.describe('Id do card de ambiguidade.'),
        expected_rev: Rev.describe('Rev do card na sua última leitura.'),
        decisao: Body.min(1).describe('O que foi decidido e por quem (ex.: "o usuário escolheu X porque Y").')
      },
      async (a) =>
        guard('plan_ambiguidade_resolver', async () => {
          const plan = await open()
          const current = find(plan, a.id)
          if (!current) return text(`Não existe card ${a.id}.`)
          if (current.tipo !== 'ambiguidade') return text(`O card ${a.id} é do tipo ${current.tipo}, não ambiguidade.`)
          if (current.status === 'resolvida') return text(`A ambiguidade ${a.id} já está resolvida; nada gravado.`)
          if (current.rev !== a.expected_rev) throw new RevConflictError(current, a.expected_rev)
          const corpo = `${current.corpo.trimEnd()}\n\n## Decisão (${isoDay(now())})\n\n${a.decisao.trim()}\n`
          const saved = await store.saveCard(projectCwd, slug, { ...current, status: 'resolvida', corpo }, a.expected_rev)
          changed()
          return text(`Ambiguidade resolvida: ${cardHeader(saved)}. Se a decisão muda outros cards, atualize-os.`)
        })
    )),

    roteiroTools.handoffWrite,
    roteiroTools.handoffLimpar,

    erase(tool(
      'plan_midia_importar',
      'Copia um arquivo (imagem, PDF, vídeo, áudio, planilha, documento… — um anexo do chat, um arquivo do projeto, algo do _sandbox) para a pasta midia/ do planejamento, com nome saneado, e devolve o nome (é ele que vai em "anexos"), o tipo e o caminho absoluto. Com card_id (exige expected_rev), já anexa ao card; se o card não existir ou o rev não bater, nada é copiado e a resposta traz o card atual.',
      {
        caminho: z.string().min(1).max(4096).describe('Arquivo de origem: caminho absoluto, ou relativo à raiz do projeto.'),
        card_id: Name.optional().describe('Id do card ao qual anexar a mídia.'),
        expected_rev: Rev.optional().describe('Rev do card na sua última leitura (obrigatório com card_id).')
      },
      async (a) => guard('plan_midia_importar', () => importAndAttach(mediaDeps, a))
    ))
  ]
}

export function createPlanningMcpServer(ctx: PlanningToolContext): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({ name: PLANNING_MCP_SERVER, version: '1.0.0', tools: buildPlanningTools(ctx) })
}
