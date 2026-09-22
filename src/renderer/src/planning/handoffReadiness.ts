/**
 * Conferência do plano antes de enviá-lo para implementação, e o rascunho
 * automático do prompt de handoff. Puro: recebe o plano aberto e devolve dados
 * ou texto — nada de IPC nem de estado.
 *
 * - Bloqueio: ambiguidade ainda aberta (a implementação teria de adivinhar).
 * - Aviso: roteiro vazio, etapa sem card, etapa não concluída, card inválido.
 * - buildDraftHandoff: markdown determinístico (mesmo plano → mesmo texto).
 */
import type { OpenedPlanningDto, PlanningCardDto, PlanningCardType, PlanningStageStatus } from '@shared/ipc'

export type HandoffIssueKind =
  | 'ambiguidade-aberta'
  | 'roteiro-vazio'
  | 'etapa-sem-card'
  | 'etapa-nao-concluida'
  | 'card-invalido'

export interface HandoffIssue {
  kind: HandoffIssueKind
  /** Frase pronta para a tela. */
  text: string
  /** Id do card ou da etapa, ou o arquivo inválido. */
  ref?: string
}

export interface HandoffReadiness {
  /** Impedem o envio, a menos que o usuário escolha enviar mesmo assim. */
  blockers: HandoffIssue[]
  /** Não impedem; só avisam. */
  warnings: HandoffIssue[]
}

export const STAGE_STATUS_LABEL: Record<PlanningStageStatus, string> = {
  pendente: 'pendente',
  em_andamento: 'em andamento',
  concluida: 'concluída'
}

const TYPE_LABEL: Record<PlanningCardType, string> = {
  requisito: 'Requisito',
  decisao: 'Decisão',
  sugestao: 'Sugestão',
  ambiguidade: 'Ambiguidade',
  nota: 'Nota',
  etapa: 'Etapa'
}

const TYPE_ORDER: Record<PlanningCardType, number> = {
  requisito: 0,
  decisao: 1,
  sugestao: 2,
  ambiguidade: 3,
  nota: 4,
  etapa: 5
}

/** Ambiguidade sem decisão: qualquer status que não seja 'resolvida'. */
export function isOpenAmbiguity(card: PlanningCardDto): boolean {
  return card.tipo === 'ambiguidade' && card.status !== 'resolvida'
}

export function handoffReadiness(plan: OpenedPlanningDto): HandoffReadiness {
  const blockers: HandoffIssue[] = plan.cards
    .filter(isOpenAmbiguity)
    .sort((a, b) => cmp(a.id, b.id))
    .map((c) => ({ kind: 'ambiguidade-aberta', ref: c.id, text: `Ambiguidade aberta: "${c.titulo}"` }))

  const warnings: HandoffIssue[] = []
  const etapas = plan.roteiro.etapas
  if (etapas.length === 0) {
    warnings.push({ kind: 'roteiro-vazio', text: 'O roteiro não tem etapas: a implementação não terá uma ordem a seguir.' })
  }
  for (const e of etapas) {
    if (!plan.cards.some((c) => c.etapa === e.id)) {
      warnings.push({ kind: 'etapa-sem-card', ref: e.id, text: `A etapa "${e.titulo}" não tem nenhum card.` })
    }
  }
  for (const e of etapas) {
    if (e.status !== 'concluida') {
      warnings.push({
        kind: 'etapa-nao-concluida',
        ref: e.id,
        text: `A etapa "${e.titulo}" ainda está ${STAGE_STATUS_LABEL[e.status] ?? e.status}.`
      })
    }
  }
  for (const f of plan.invalid) {
    warnings.push({ kind: 'card-invalido', ref: f.file, text: `Card inválido, fica de fora: ${f.file} (${f.error}).` })
  }
  return { blockers, warnings }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Cards na ordem do roteiro (etapa desconhecida por último), depois por tipo e id. */
function sortCards(plan: OpenedPlanningDto, cards: PlanningCardDto[]): PlanningCardDto[] {
  const order = new Map(plan.roteiro.etapas.map((e, i) => [e.id, i]))
  const pos = (c: PlanningCardDto): number => (c.etapa !== undefined && order.has(c.etapa) ? order.get(c.etapa)! : 1e9)
  return [...cards].sort((a, b) => pos(a) - pos(b) || TYPE_ORDER[a.tipo] - TYPE_ORDER[b.tipo] || cmp(a.id, b.id))
}

/** Rebaixa os títulos markdown do corpo de um card (fora de blocos de código),
 *  para não competirem com as seções do prompt. */
export function demoteHeadings(text: string, levels: number): string {
  let fence: string | null = null
  return text
    .split(/\r?\n/)
    .map((line) => {
      const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
      if (f) {
        if (fence === null) fence = f[1][0]
        else if (f[1][0] === fence) fence = null
        return line
      }
      if (fence !== null) return line
      const h = /^(#{1,6})(?=\s)/.exec(line)
      if (!h) return line
      return '#'.repeat(Math.min(6, h[1].length + levels)) + line.slice(h[1].length)
    })
    .join('\n')
}

function cardRef(c: PlanningCardDto): string {
  return `\`cards/${c.id}.md\``
}

function cardBody(c: PlanningCardDto, empty: string): string {
  const body = c.corpo.trim()
  return body ? demoteHeadings(body, 3) : empty
}

function detailSection(title: string, cards: PlanningCardDto[], render: (c: PlanningCardDto) => string[]): string[] {
  if (cards.length === 0) return []
  const out = [`## ${title}`, '']
  for (const c of cards) out.push(`### ${c.titulo} (${cardRef(c)})`, '', ...render(c), '')
  return out
}

/**
 * O rascunho automático do prompt de handoff: objetivo, etapas na ordem com os
 * seus cards, requisitos, decisões com o porquê, sugestões com a fonte,
 * ambiguidades resolvidas (e as ainda abertas, se o usuário enviar assim) e a
 * instrução de declarar as etapas como plano e consultar docs/spec/<slug>/.
 */
export function buildDraftHandoff(plan: OpenedPlanningDto): string {
  const { slug, roteiro } = plan
  const titulo = roteiro.titulo.trim() || slug
  const cards = sortCards(plan, plan.cards)
  const of = (tipo: PlanningCardType): PlanningCardDto[] => cards.filter((c) => c.tipo === tipo)
  const etapaIds = new Set(roteiro.etapas.map((e) => e.id))
  const n = roteiro.etapas.length

  const out: string[] = [
    `# Implementação: ${titulo}`,
    '',
    `Esta conversa implementa o planejamento **${titulo}**, feito com o usuário na Tela de Planejamento. ` +
      `O plano detalhado está em \`docs/spec/${slug}/\`: \`_roteiro.md\` (as etapas, na ordem) e \`cards/\` (um arquivo por card).`,
    '',
    '## Objetivo',
    '',
    n > 0
      ? `${titulo}. Entregar ${n === 1 ? 'a etapa' : `as ${n} etapas`} do roteiro, na ordem, respeitando os requisitos e as decisões abaixo.`
      : `${titulo}. O roteiro ainda não tem etapas: siga os requisitos e as decisões abaixo.`,
    ''
  ]

  if (n > 0) {
    out.push('## Etapas, na ordem', '')
    roteiro.etapas.forEach((e, i) => {
      out.push(`${i + 1}. **${e.titulo}** (\`${e.id}\`) — ${STAGE_STATUS_LABEL[e.status] ?? e.status}`)
      const inStage = cards.filter((c) => c.etapa === e.id)
      if (inStage.length === 0) out.push('   - _(nenhum card nesta etapa)_')
      for (const c of inStage) out.push(`   - ${TYPE_LABEL[c.tipo]}: ${c.titulo} (${cardRef(c)})`)
    })
    out.push('')
  }

  const loose = cards.filter((c) => !c.etapa || !etapaIds.has(c.etapa))
  if (loose.length > 0) {
    out.push('## Cards fora das etapas', '')
    for (const c of loose) out.push(`- ${TYPE_LABEL[c.tipo]}: ${c.titulo} (${cardRef(c)})`)
    out.push('')
  }

  out.push(...detailSection('Requisitos', of('requisito'), (c) => [cardBody(c, '_(sem detalhe no card)_')]))
  out.push(...detailSection('Decisões (com o porquê)', of('decisao'), (c) => [cardBody(c, '_(o card não registra o porquê)_')]))
  out.push(
    ...detailSection('Sugestões (com fonte)', of('sugestao'), (c) => [
      `Fonte: ${c.fonte ?? '(sem fonte)'}`,
      '',
      cardBody(c, '_(sem detalhe no card)_')
    ])
  )
  const ambiguidades = of('ambiguidade')
  out.push(
    ...detailSection('Ambiguidades resolvidas', ambiguidades.filter((c) => !isOpenAmbiguity(c)), (c) => [
      cardBody(c, '_(sem registro da decisão no card)_')
    ])
  )
  const abertas = ambiguidades.filter(isOpenAmbiguity)
  if (abertas.length > 0) {
    out.push('## Ambiguidades ainda abertas', '')
    for (const c of abertas) {
      out.push(`- **${c.titulo}** (${cardRef(c)}) — sem decisão: confirme com o usuário antes de implementar o que depende dela.`)
    }
    out.push('')
  }
  out.push(
    ...detailSection('Notas', [...of('nota'), ...of('etapa')], (c) => [cardBody(c, '_(sem texto no card)_')])
  )

  out.push(
    '## Como trabalhar',
    '',
    '- Antes de começar, declare as etapas acima como o seu plano (TodoWrite ou TaskCreate), na mesma ordem, e siga-as sem replanejar.',
    `- Consulte \`docs/spec/${slug}/\` (roteiro e cards) sempre que precisar de detalhe: os cards são a fonte das decisões.`,
    '- Se o código real contradisser o plano, diga ao usuário o que encontrou e pergunte antes de desviar dele.',
    ''
  )
  return out.join('\n')
}
