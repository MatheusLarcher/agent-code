import type { MemoristaProviderDiagnosticMsg, PoProviderDiagnosticMsg } from '@shared/ipc'
import type { AgentTrack, TrackMap, TrackStep } from './agentTracks'

/**
 * O ELENCO — quem é o time e o que cada um está fazendo agora.
 *
 * A diferença para `agentTracks` é o eixo: lá a unidade é a *delegação* (uma
 * trilha por `Agent` disparado, que nasce e morre), aqui a unidade é o *papel*.
 * Um papel está sempre em cena, mesmo parado, e é justamente o contraste com o
 * estado parado que faz "começou a trabalhar" ser percebido sem o usuário estar
 * olhando para o painel — uma lista que só cresce não tem transição para notar.
 *
 * Módulo puro (sem React, sem IPC) para as regras serem testáveis sozinhas.
 */

/** Um papel do time. `subagente` é o escape para um tipo que o SDK trouxe e
 *  que não é um dos nossos especialistas (`Explore`, `general-purpose`…). */
export type CrewRole =
  | 'principal'
  | 'executor'
  | 'critico'
  | 'navegador-de-codigo'
  | 'memoria'
  | 'po'
  | 'vigia'
  | 'subagente'

/** Os quatro estados do cartão. `asking` é o único que pede ação do usuário. */
export type CrewState = 'idle' | 'working' | 'asking' | 'failed'

export type CrewGroup = 'conversa' | 'observadores'

export interface CrewBadge {
  text: string
  /** `plain` sai como texto miúdo, sem pílula — uma borda em "disponível"
   *  daria ao estado parado o mesmo peso visual de um resultado. */
  tone: 'plain' | 'ok' | 'warn' | 'err'
}

/**
 * A linha "o que está fazendo" é composta, não uma string: a ferramenta entra
 * na cor do papel e os contadores de linha em verde/vermelho, e a posição de
 * cada pedaço muda conforme o caso ("delegando · Agent → critico" contra
 * "começou agora · task_get").
 */
export type CrewSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'del'; text: string }

const txt = (text: string): CrewSegment => ({ kind: 'text', text })
const tool = (text: string): CrewSegment => ({ kind: 'tool', text })

export interface CrewMember {
  /** Estável por papel, para o React não remontar o cartão a cada tique. */
  id: string
  role: CrewRole
  name: string
  /** Pílula ao lado do nome ("supervisor", "review", "tarefa 8677ee2e"). */
  kind?: string
  state: CrewState
  /** "O que está fazendo", em pedaços coloridos. */
  line: CrewSegment[]
  /** Epoch ms — alimenta o cronômetro e o pulso de chegada. */
  startedAt?: number
  endedAt?: number
  stepCount?: number
  badge?: CrewBadge
  /** Passos do subagente, quando há trilha. */
  steps?: TrackStep[]
  group: CrewGroup
}

/** Os especialistas que o app cadastra em `Options.agents`, na ordem do elenco. */
export const SPECIALIST_ROLES: CrewRole[] = ['executor', 'critico', 'navegador-de-codigo', 'memoria']

/** Quanto tempo o pulso de chegada dura. A animação toca 2× 1,4 s; passado
 *  isso o cartão fica sóbrio — piscar para sempre vira ruído de fundo. */
export const JUST_STARTED_MS = 3000

/** `subagentType` do SDK → papel do elenco. Case-insensitive porque o valor
 *  vem do modelo e já chegou com caixa trocada. */
export function roleFromSubagentType(type?: string): CrewRole {
  const t = (type ?? '').trim().toLowerCase()
  if (t === 'executor') return 'executor'
  if (t === 'critico' || t === 'crítico') return 'critico'
  if (t === 'navegador-de-codigo' || t === 'navegador-de-código') return 'navegador-de-codigo'
  if (t === 'memoria' || t === 'memória') return 'memoria'
  return 'subagente'
}

/** Rótulo curto por papel — o que aparece no cartão. */
export function roleName(role: CrewRole): string {
  if (role === 'principal') return 'Principal'
  if (role === 'po') return 'PO'
  if (role === 'vigia') return 'vigia'
  if (role === 'subagente') return 'subagente'
  return role
}

function lines(value: unknown): number {
  return typeof value === 'string' && value.length > 0 ? value.split('\n').length : 0
}

/** Linhas ganhas/perdidas de uma edição, como o card de ferramenta do chat. */
function editDelta(name: string, i: Record<string, unknown>): CrewSegment[] {
  if (name === 'Write') {
    const add = lines(i['content'])
    return add > 0 ? [{ kind: 'add', text: `+${add}` }] : []
  }
  if (name !== 'Edit' && name !== 'MultiEdit' && name !== 'NotebookEdit') return []
  const edits = Array.isArray(i['edits']) ? (i['edits'] as Record<string, unknown>[]) : [i]
  let add = 0
  let del = 0
  for (const e of edits) {
    add += lines(e['new_string'] ?? e['new_source'])
    del += lines(e['old_string'] ?? e['old_source'])
  }
  const out: CrewSegment[] = []
  if (add > 0) out.push({ kind: 'add', text: `+${add}` })
  if (del > 0) out.push({ kind: 'del', text: `−${del}` })
  return out
}

/** O que uma chamada está tocando, já em pedaços coloridos. */
export function callSegments(name: string, input: unknown): CrewSegment[] {
  const i = (input ?? {}) as Record<string, unknown>
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = i[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return undefined
  }
  const path = pick('file_path', 'path', 'notebook_path')
  if (path) {
    const short = path.split(/[\\/]/).slice(-2).join('/')
    const delta = editDelta(name, i)
    return [txt(short), ...delta.flatMap((d) => [txt(' '), d])]
  }
  const detail = pick('command', 'pattern', 'query', 'url', 'description', 'prompt')
  if (!detail) return []
  const oneLine = detail.replace(/\s+/g, ' ')
  return [txt(oneLine.length > 52 ? `${oneLine.slice(0, 51)}…` : oneLine)]
}

/** Só o texto da linha — usado em teste e em `title`. */
export function lineText(line: CrewSegment[]): string {
  return line.map((s) => s.text).join('')
}

/** Mais recente primeiro; trilha rodando ganha de trilha terminada. */
function pickTrack(tracks: AgentTrack[]): AgentTrack | undefined {
  const running = tracks.filter((t) => t.status === 'running')
  const pool = running.length > 0 ? running : tracks
  return pool.reduce<AgentTrack | undefined>(
    (best, t) => (!best || t.startedAt > best.startedAt ? t : best),
    undefined
  )
}

function memberFromTrack(
  role: CrewRole,
  track: AgentTrack,
  alsoRunning: number,
  now: number
): CrewMember {
  const last = track.steps[track.steps.length - 1]
  const running = track.status === 'running'
  const base: CrewMember = {
    id: `role:${role}`,
    role,
    name: roleName(role),
    state: running ? 'working' : track.status === 'error' ? 'failed' : 'idle',
    line: [],
    startedAt: track.startedAt,
    stepCount: track.stepCount,
    steps: track.steps,
    group: 'conversa',
    ...(track.endedAt === undefined ? {} : { endedAt: track.endedAt })
  }
  // Mais de uma trilha do mesmo papel ao mesmo tempo: o cartão mostra a mais
  // recente e diz quantas são, em vez de duplicar a linha do papel.
  if (alsoRunning > 1) base.kind = `${alsoRunning} em paralelo`

  if (running) {
    if (!last) {
      base.line = [txt('iniciando…')]
    } else if (now - track.startedAt < JUST_STARTED_MS) {
      // Nos primeiros segundos o que importa é que ELE ENTROU — a ferramenta
      // vem junto, mas a manchete é a chegada.
      base.line = [txt('começou agora · '), tool(last.name)]
    } else {
      const detail = callSegments(last.name, last.input)
      base.line = [tool(last.name), ...(detail.length > 0 ? [txt(' '), ...detail] : [])]
    }
    return base
  }
  if (track.status === 'error') {
    base.line = [txt('terminou com erro')]
    base.badge = { text: 'erro', tone: 'err' }
    return base
  }
  base.line = [txt(`terminou · ${track.stepCount} chamada${track.stepCount === 1 ? '' : 's'}`)]
  base.badge = { text: 'pronto', tone: 'ok' }
  return base
}

function idleMember(role: CrewRole): CrewMember {
  return {
    id: `role:${role}`,
    role,
    name: roleName(role),
    state: 'idle',
    line: [txt('parado')],
    badge: { text: 'disponível', tone: 'plain' },
    group: 'conversa'
  }
}

export interface CrewInput {
  tracks: TrackMap
  /** O turno do agente principal está em andamento? */
  busy: boolean
  /** Quando o turno começou (epoch ms). */
  busySince: number | null
  /** Dúvida do vigia aberta nesta conversa, se houver. */
  vigia: { at: number } | null
  /** Último diagnóstico do PO desta conversa. */
  po: PoProviderDiagnosticMsg | null
  /** Último diagnóstico do memorista desta conversa. Ele NÃO ganha cartão
   *  próprio: acende o do papel `memoria`, que já está no elenco. */
  memorista?: MemoristaProviderDiagnosticMsg | null
  /** O observador está ligado nas configurações? Desligado, some do elenco. */
  poEnabled: boolean
  vigiaEnabled: boolean
  /** Desligado nas Configurações, o cartão `memoria` volta a ser só o do
   *  subagente delegado — não some, porque o papel continua existindo. */
  memoristaEnabled?: boolean
  /** Injetável para o teste fixar o "acabou de começar". */
  now?: number
}

function poMember(po: PoProviderDiagnosticMsg | null): CrewMember {
  const base: CrewMember = {
    id: 'role:po',
    role: 'po',
    name: 'PO',
    // A pílula é o papel inteiro, não a rodada: ele abre o quadro e o fecha. E é
    // CUIDAR, não possuir — o esqueleto do quadro é do agente (`source_*`), o PO
    // só escreve a camada de cima (`po_*`). Chamá-lo de dono diria ao usuário o
    // contrário do que o desenho garante.
    kind: 'cuida do quadro',
    state: 'idle',
    // O estado parado é onde o cartão passa a maior parte do tempo, então é ele
    // que ensina o papel. São DUAS rodadas por turno, e dizer só a auditoria do
    // fim faria o usuário estranhar a rodada da abertura como trabalho repetido.
    line: [txt('registra o pedido na abertura e audita no fim do turno')],
    badge: { text: 'disponível', tone: 'plain' },
    group: 'observadores'
  }
  if (!po) return base

  const model = po.actualProvider === 'gpt-luna' ? 'gpt-6-luna' : 'claude'
  // O PO roda DUAS vezes por turno e as duas rodadas acendem o mesmo cartão. Sem
  // dizer qual é qual, o usuário vê o mesmo "auditando" duas vezes e conclui que
  // o observador está repetindo trabalho. `round` ausente é o diagnóstico antigo
  // (ou de um main mais velho): cai no texto de sempre, nunca em "undefined".
  const abertura = po.round === 'open'
  if (po.phase === 'audit-finished') {
    const n = po.appliedOps ?? 0
    base.line = [
      txt(
        abertura
          ? n === 0
            ? 'conferiu o pedido · nada a registrar'
            : // A abertura tanto ABRE cartão quanto marca ANDAMENTO num que já
              // existia, e a contagem não distingue os dois. "Aberto" descreveria
              // metade dos casos; "em andamento" é o estado em que a rodada
              // deixa o cartão nos DOIS caminhos.
              `registrou o pedido · ${n} ${n > 1 ? 'cartões' : 'cartão'} em andamento`
          : n === 0
            ? 'auditou no fim do turno · nada a corrigir'
            : `auditou no fim do turno · ${n} ${n > 1 ? 'cartões corrigidos' : 'cartão corrigido'}`
      )
    ]
    base.badge = { text: model, tone: 'ok' }
    base.endedAt = po.at
    return base
  }
  if (po.phase === 'gpt-luna-unavailable') {
    base.state = 'failed'
    base.line = [
      txt(
        abertura
          ? 'não consegui registrar o pedido · GPT Luna indisponível'
          : 'não consegui auditar · GPT Luna indisponível'
      )
    ]
    base.badge = { text: 'falhou', tone: 'err' }
    base.endedAt = po.at
    return base
  }
  base.state = 'working'
  base.startedAt = po.at
  delete base.badge
  base.line =
    po.phase === 'gpt-luna-started'
      ? abertura
        ? [tool('registrando'), txt(` o pedido · continuando com ${model}`)]
        : [tool('auditando'), txt(` · continuando com ${model}`)]
      : po.phase === 'po-provider-switch' || po.phase === 'claude-unavailable'
        ? // A troca de provedor é a mesma nas duas rodadas: o que mudou é o
          // modelo, e é ele que a linha precisa mostrar.
          [txt('trocando de provedor · '), tool(model)]
        : abertura
          ? [tool('registrando'), txt(' o pedido no quadro')]
          : [tool('auditando'), txt(' o quadro desta conversa')]
  return base
}

/**
 * O cartão do papel `memoria` quando quem o acende é o MEMORISTA (o observador
 * do main), e não uma delegação do agente principal.
 *
 * Ele reusa o cartão que já existe em vez de ganhar um próprio porque para o
 * usuário é o mesmo papel — quem cuida do que o app lembra. Dois cartões de
 * memória lado a lado só fariam perguntar qual dos dois é o de verdade.
 */
function memoristaMember(memorista: MemoristaProviderDiagnosticMsg | null): CrewMember {
  const base: CrewMember = {
    id: 'role:memoria',
    role: 'memoria',
    name: roleName('memoria'),
    kind: 'guarda o que você ensina',
    state: 'idle',
    // O estado parado é onde o cartão fica quase sempre, então é ele que ensina
    // o papel — e o que surpreende aqui é o SOZINHO: ninguém precisa pedir.
    line: [txt('anota sozinho, no fim do turno, o que vale lembrar')],
    badge: { text: 'disponível', tone: 'plain' },
    group: 'conversa'
  }
  if (!memorista) return base

  const model = memorista.actualProvider === 'gpt-luna' ? 'gpt-6-luna' : 'claude'
  if (memorista.phase === 'analysis-finished') {
    const n = memorista.savedMemories ?? 0
    // Zero é o caso NORMAL, não uma falha: a maioria dos turnos não ensina nada
    // que valha guardar. Dizer "nada a guardar" evita ler silêncio como erro.
    base.line = [
      txt(n === 0 ? 'leu a conversa · nada a guardar' : `guardou ${n} ${n > 1 ? 'memórias' : 'memória'}`)
    ]
    base.badge = { text: model, tone: 'ok' }
    base.endedAt = memorista.at
    return base
  }
  if (memorista.phase === 'gpt-luna-unavailable') {
    base.state = 'failed'
    base.line = [txt('não consegui ler a conversa · GPT Luna indisponível')]
    base.badge = { text: 'falhou', tone: 'err' }
    base.endedAt = memorista.at
    return base
  }
  base.state = 'working'
  base.startedAt = memorista.at
  delete base.badge
  base.line =
    memorista.phase === 'gpt-luna-started'
      ? [tool('lendo'), txt(` a conversa · continuando com ${model}`)]
      : memorista.phase === 'memorista-provider-switch' || memorista.phase === 'claude-unavailable'
        ? [txt('trocando de provedor · '), tool(model)]
        : [tool('lendo'), txt(' a conversa')]
  return base
}

function vigiaMember(vigia: { at: number } | null): CrewMember {
  if (!vigia) {
    return {
      id: 'role:vigia',
      role: 'vigia',
      name: 'vigia',
      kind: 'observador',
      state: 'idle',
      line: [txt('questiona a premissa enquanto o agente trabalha')],
      badge: { text: 'disponível', tone: 'plain' },
      group: 'observadores'
    }
  }
  return {
    id: 'role:vigia',
    role: 'vigia',
    name: 'vigia',
    kind: 'observador',
    state: 'asking',
    line: [txt('1 dúvida esperando você')],
    endedAt: vigia.at,
    badge: { text: 'responder', tone: 'warn' },
    group: 'observadores'
  }
}

/**
 * Monta o elenco inteiro: papel por papel, sempre na mesma ordem, para o
 * cartão de um agente nunca "pular de lugar" quando outro começa a trabalhar.
 */
export function buildCrew(input: CrewInput): CrewMember[] {
  const all = Object.values(input.tracks)
  const byRole = new Map<CrewRole, AgentTrack[]>()
  const strays: AgentTrack[] = []
  for (const track of all) {
    const role = roleFromSubagentType(track.subagentType)
    if (role === 'subagente') {
      strays.push(track)
      continue
    }
    const list = byRole.get(role) ?? []
    list.push(track)
    byRole.set(role, list)
  }

  const now = input.now ?? Date.now()
  const running = all.filter((t) => t.status === 'running')
  const delegatedTo = running
    .map((t) => roleName(roleFromSubagentType(t.subagentType)))
    .filter((n, i, arr) => arr.indexOf(n) === i)
  const principal: CrewMember = {
    id: 'role:principal',
    role: 'principal',
    name: 'Principal',
    kind: 'supervisor',
    state: input.busy ? 'working' : 'idle',
    line: !input.busy
      ? [txt('esperando seu próximo pedido')]
      : running.length > 0
        ? [txt('delegando · '), tool('Agent'), txt(` → ${delegatedTo.join(', ')}`)]
        : [txt('executando sozinho')],
    group: 'conversa',
    ...(input.busy && input.busySince != null ? { startedAt: input.busySince } : {})
  }
  if (!input.busy) principal.badge = { text: 'ocioso', tone: 'plain' }

  const members: CrewMember[] = [principal]
  for (const role of SPECIALIST_ROLES) {
    const list = byRole.get(role) ?? []
    const track = pickTrack(list)
    if (track) {
      members.push(memberFromTrack(role, track, list.filter((t) => t.status === 'running').length, now))
      continue
    }
    // Sem delegação em cena, o cartão de `memoria` é do memorista. A delegação
    // ganha do observador porque ela é trabalho DESTE turno, com passos para
    // mostrar; o memorista só entra quando o slot estaria parado de qualquer
    // jeito — e assim o cartão nunca muda de posição, só de conteúdo.
    members.push(
      role === 'memoria' && input.memoristaEnabled
        ? memoristaMember(input.memorista ?? null)
        : idleMember(role)
    )
  }
  // Subagentes que não são do nosso cadastro entram como linhas próprias — com
  // a identidade da trilha, porque não existe "o papel" para reaproveitar.
  for (const track of strays.sort((a, b) => b.startedAt - a.startedAt)) {
    const m = memberFromTrack('subagente', track, 1, now)
    m.id = `track:${track.id}`
    m.name = track.subagentType || 'subagente'
    m.kind = track.label.length > 42 ? `${track.label.slice(0, 41)}…` : track.label
    members.push(m)
  }

  if (input.poEnabled) members.push(poMember(input.po))
  if (input.vigiaEnabled) members.push(vigiaMember(input.vigia))
  return members
}

/** Quem está de fato trabalhando agora — alimenta o chip da topbar. */
export function workingMembers(crew: CrewMember[]): CrewMember[] {
  return crew.filter((m) => m.state === 'working')
}

/** Papéis que o Quadro mostra no CABEÇALHO DA COLUNA, não no cartão: eles só
 *  sabem em qual CONVERSA estão, nunca em qual cartão — diferente do
 *  `executor`, que ganha bolinha própria por cartão via `boardItemId`. */
const BOARD_HEADER_ROLES: CrewRole[] = ['critico', 'po', 'vigia', 'memoria']

/**
 * Do elenco de uma conversa, quem entra nas bolinhas do cabeçalho de coluna do
 * Quadro: só os papéis de `BOARD_HEADER_ROLES`, e só enquanto ATIVOS — parado
 * ("disponível") é o estado da maior parte do tempo, e mostrá-lo sempre viraria
 * mobília em toda coluna, de toda conversa.
 */
export function activeColumnCrew(crew: CrewMember[]): CrewMember[] {
  return crew.filter((m) => BOARD_HEADER_ROLES.includes(m.role) && m.state !== 'idle')
}

export interface CrewLane {
  member: CrewMember
  /** 0..100 — começo e largura da faixa dentro da janela do turno. */
  left: number
  width: number
  live: boolean
}

/**
 * Faixas da linha do tempo, normalizadas pela janela do turno. Sem janela
 * (nada começou ainda) devolve vazio em vez de dividir por zero.
 */
export function buildLanes(crew: CrewMember[], now: number): CrewLane[] {
  const marks = crew.flatMap((m) => [m.startedAt, m.endedAt].filter((v): v is number => v != null))
  if (marks.length === 0) return []
  const start = Math.min(...marks)
  const span = Math.max(now, ...marks) - start
  if (span <= 0) return []

  const lanes: CrewLane[] = []
  for (const m of crew) {
    if (m.startedAt == null && m.endedAt == null) continue
    const from = m.startedAt ?? m.endedAt ?? start
    const to = m.state === 'working' ? now : m.endedAt ?? from
    const left = ((from - start) / span) * 100
    // Piso de 1,5% para um evento instantâneo não virar uma faixa invisível.
    const width = Math.max(1.5, ((to - from) / span) * 100)
    lanes.push({
      member: m,
      left: Math.max(0, Math.min(100, left)),
      width: Math.max(0, Math.min(100 - Math.max(0, Math.min(100, left)), width)),
      live: m.state === 'working'
    })
  }
  return lanes
}
