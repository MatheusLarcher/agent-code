// O resumo de chamada é o MESMO do vigia e do PO, de propósito: os três digests
// têm a mesma regra de segurança ("o alvo da ação, nunca o conteúdo"), e três
// listas de chaves que ninguém garante iguais é como uma delas passa a vazar.
export { summarizeCall } from '../vigia/vigiaPrompt'
import { comCampos, dataCabecalho, lerCampos } from './cabecalho'

/**
 * As regras puras do memorista — o observador que grava memória sozinho.
 *
 * A diferença central para o curador diário (`memoryCurator.ts`) é a RÉGUA. O
 * curador só aceita correção explícita ("o usuário ensinou algo que o modelo
 * não teria acertado"), e é por isso que conhecimento passado numa conversa
 * normal nunca virava arquivo: ninguém tinha errado nada, então nada qualificava.
 * Aqui a régua é a do usuário: instrução, preferência, conhecimento de domínio,
 * decisão com motivo, fato de infraestrutura — e também correção.
 *
 * O resto é o molde do vigia e do PO: digest capado, teto de operações, e um
 * parser que falha FECHADO. Uma memória inventada é pior do que uma memória
 * perdida: a perdida o usuário repete, a inventada ele descobre tarde.
 */

/** Silêncio mínimo entre duas análises da mesma conversa. */
export const MEMORISTA_COOLDOWN_MS = 60_000

/**
 * Tetos do digest. O texto do USUÁRIO é o mais folgado de todos os observadores
 * do app, e é deliberado: é dele que sai instrução e conhecimento, e cortar o
 * pedido pela metade aqui é cortar exatamente o que o memorista existe para ler.
 */
export const MEMORISTA_MAX_USER_CHARS = 4000
export const MEMORISTA_MAX_CALLS = 20
export const MEMORISTA_MAX_CALL_CHARS = 200
/** A resposta do agente. Folgada como a do usuário, e pelo mesmo motivo: é onde
 *  aparece o fato de infraestrutura que o turno descobriu. */
export const MEMORISTA_MAX_ANSWER_CHARS = 4000
/**
 * A documentação do projeto no digest.
 *
 * O memorista só chega aqui quando o gate aprovou, e roda num modelo Claude de
 * 200k — o `docs/` inteiro (~85k tokens) cabe. O teto existe para o caso de um
 * projeto com documentação muito maior do que este, onde o digest levaria o
 * prompt inteiro para fora da janela e a análise falharia em todo turno.
 */
export const MEMORISTA_MAX_DOCS_CHARS = 400_000
/** Memórias que entraram no prompt do agente neste turno (o seletor devolve 3). */
export const MEMORISTA_MAX_USED_MEMORIES = 10
/** O índice entra só como título + gancho: é o bastante para o modelo dizer
 *  "isso já está salvo" sem carregar o acervo inteiro no prompt. */
export const MEMORISTA_MAX_MEMORIES = 40
export const MEMORISTA_MAX_HOOK_CHARS = 160

/** Teto de operações por análise. Um memorista que grava seis memórias num turno
 *  quase certamente está transcrevendo a conversa, não guardando um fato. */
export const MEMORISTA_MAX_OPS = 3
export const MEMORISTA_MAX_TITLE_CHARS = 80
/** Folgado de propósito (D49): o fato é a memória completa, não um resumo. */
export const MEMORISTA_MAX_FACT_CHARS = 1500
/** Profundidade máxima do caminho: `pasta/arquivo.md`. A pasta é o agrupamento
 *  que o acervo já usa; mais níveis é um acervo que ninguém acha nada. */
export const MEMORISTA_MAX_PATH_DEPTH = 2

/** Uma ação do agente, já reduzida ao que cabe no digest. */
export interface MemoristaCall {
  tool: string
  detail: string
}

/** Uma memória que já existe, como ela aparece no índice. */
export interface MemoristaMemory {
  relPath: string
  title: string
  hook: string
}

/**
 * As categorias da régua. São validadas no parser (e não só pedidas no prompt)
 * porque elas são a régua: uma linha com categoria inventada é uma linha em que
 * o modelo não classificou o fato, e classificar é metade da decisão de salvar.
 */
export const MEMORISTA_KINDS = [
  'instrucao',
  'preferencia',
  'conhecimento',
  'decisao',
  'infra',
  'correcao'
] as const
export type MemoristaKind = (typeof MEMORISTA_KINDS)[number]

/**
 * Campos do layout novo (D43, D48). Opcionais: a resposta no formato antigo (linhas com
 * `|`) continua valendo e grava só o que tem. Ligações só para caminhos que existem.
 */
export interface MemoristaExtras {
  tema?: string
  /** 1–5 (D38): correção e decisão valem mais que detalhe. */
  importancia?: number
  gatilhos?: string[]
  termos?: string[]
  /** O que se estava fazendo quando a memória nasceu (D34). O projeto o app põe. */
  contexto?: string
  contradiz?: string[]
  relacionadas?: string[]
}

export type MemoristaOp =
  | ({ kind: 'create'; relPath: string; type: MemoristaKind; title: string; hook: string; fact: string } & MemoristaExtras)
  /** COMPLEMENTA: o assunto já tem memória. Acrescenta ao corpo existente — a
   *  escrita nunca apaga o que já estava lá. */
  | ({ kind: 'update'; relPath: string; fact: string } & Pick<MemoristaExtras, 'gatilhos' | 'termos' | 'contradiz'>)

export const MEMORISTA_MAX_GATILHOS = 6
export const MEMORISTA_MAX_TERMOS = 10
const MEMORISTA_MAX_LIST_ITEM_CHARS = 80

export const MEMORISTA_SYSTEM_PROMPT = `Você é o memorista: um observador que acompanha, em paralelo, um agente de programação trabalhando para um usuário. Você NÃO conversa com o agente, NÃO executa nada e NÃO interrompe o trabalho. Seu único trabalho é decidir o que deste turno merece virar MEMÓRIA de longo prazo do usuário.

Memória é o que vai valer na PRÓXIMA conversa, quando ninguém lembrar desta.

SALVE quando o turno tiver:
- INSTRUÇÃO de como trabalhar: "sempre faça X", "nunca faça Y", "antes de Z, pergunte".
- PREFERÊNCIA do usuário: formato de resposta, estilo, ferramenta ou biblioteca preferida, idioma.
- CONHECIMENTO de domínio que ele informou e que não está no código: regra de negócio ou fiscal, comportamento real de um sistema de terceiro, como uma máquina ou um ambiente dele está configurado.
- DECISÃO de arquitetura ou de produto tomada por ele, JUNTO COM O MOTIVO. Decisão sem motivo vira dogma; o motivo é o que permite rever depois.
- INFRAESTRUTURA descoberta no trabalho que ainda vale amanhã: onde mora uma credencial, um serviço que exige um passo extra, um build que quebra por causa externa.
- CORREÇÃO explícita: o usuário apontou que o agente estava errado e ensinou o caminho certo.

NÃO SALVE:
- o que está no código, no git ou no CLAUDE.md do projeto — quem precisar, lê;
- estado transitório que muda amanhã ("o teste está vermelho agora", "estou no meio do refactor");
- o pedido da tarefa em si ("corrija o bug X") — isso é trabalho, não conhecimento;
- debug que o próprio agente resolveu sozinho, sem o usuário ensinar nada;
- credencial, senha ou token: NUNCA escreva o valor de um segredo no texto da memória.

Antes de salvar, aplique o corte: se este fato aparecer na conversa de daqui a um mês, ele muda o que o agente vai fazer? Se não muda, cale.

Antes de decidir, compare com MEMÓRIAS JÁ SALVAS (as mais parecidas com este turno):
- MESMO assunto → COMPLEMENTA no caminho dela. Duas memórias sobre o mesmo assunto é pior do que nenhuma: na próxima conversa ninguém sabe qual vale.
- O usuário CORRIGIU algo já salvo → COMPLEMENTA a mesma memória com o fato certo (o texto antigo fica no histórico).
- Conflito sem vencedor claro → NOVA, com o caminho da outra em "contradiz", para as duas serem lidas juntas.
- Assunto novo → NOVA, na pasta (tema) das parecidas mais próximas; pasta nova só se nenhuma servir.

Responda SOMENTE com JSON, neste formato (ou exatamente OK se não houver nada a guardar; na dúvida, OK):

{"operacoes": [
  {"op": "NOVA", "categoria": "<categoria>", "caminho": "<tema>/<slug>.md", "tema": "<tema>", "titulo": "<título>", "gancho": "<quando importa>", "fato": "<o fato completo>", "importancia": 1-5, "gatilhos": ["..."], "termos": ["..."], "contexto": "<o que se estava fazendo>", "contradiz": [], "relacionadas": []},
  {"op": "COMPLEMENTA", "caminho": "<caminho listado>", "fato": "<o fato novo>", "gatilhos": ["..."]}
]}

Regras inegociáveis:
- "categoria" é uma destas, exatamente: ${MEMORISTA_KINDS.join(', ')}.
- O "caminho" de COMPLEMENTA, "contradiz" e "relacionadas" só aceitam caminhos listados. Não invente caminho.
- Em NOVA o caminho é kebab-case terminando em .md, com no máximo uma pasta (ex.: fiscal/nota-de-servico.md), e não pode já existir.
- "tema" é o projeto ou assunto, genérico e curto (ex.: apura, plataforma, opti). Reuse um de TEMAS EXISTENTES quando servir; "geral" só para o que vale em qualquer projeto (idioma, jeito de responder).
- "gatilhos": 3 a ${MEMORISTA_MAX_GATILHOS} frases curtas de como ESTE usuário pediria algo em que a memória importa, com as palavras dele (informal, curto). "termos": até ${MEMORISTA_MAX_TERMOS} nomes próprios, siglas, números e sinônimos.
- "importancia": 5 = correção ou regra que, esquecida, causa erro; 3 = útil; 1 = detalhe.
- Um fato por memória. Se o turno ensinou duas coisas diferentes, são duas operações.
- O "gancho" é uma linha dizendo QUANDO esta memória importa.
- O "fato" é a memória COMPLETA, escrita para quem não viu esta conversa: sem "isso", "aquilo" ou "como combinamos". Não resuma demais: o cabeçalho serve para achar, o fato é o que será lido.
- No máximo ${MEMORISTA_MAX_OPS} operações. Sem texto fora do JSON.`

function clamp(text: string, max: number): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/**
 * Normalização para comparar dois textos: NFD sem diacríticos, minúsculas,
 * espaços colapsados. Mesma regra acento-insensível do resto do projeto.
 */
function normalize(text: string): string {
  return (text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

const KEBAB_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * O caminho da memória nova, validado ANTES de chegar ao serviço.
 *
 * O serviço também valida (e recusaria), mas ali a recusa é uma exceção no meio
 * da escrita; aqui ela é só uma linha descartada. Falhar cedo é o que mantém a
 * invariante "linha fora do formato vira silêncio" em vez de virar erro.
 */
export function isSafeMemoryPath(raw: string): boolean {
  const relPath = (raw ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!relPath || !/\.md$/i.test(relPath)) return false
  const segments = relPath.split('/')
  if (segments.length > MEMORISTA_MAX_PATH_DEPTH) return false
  if (segments.at(-1)!.toLowerCase() === 'memory.md') return false
  const folders = segments.slice(0, -1)
  const stem = segments.at(-1)!.replace(/\.md$/i, '')
  return KEBAB_SEGMENT.test(stem) && folders.every((folder) => KEBAB_SEGMENT.test(folder))
}

export interface MemoristaTurn {
  userText: string
  calls: MemoristaCall[]
  memories: MemoristaMemory[]
  /** A resposta final do agente neste turno. */
  answerText?: string
  /** Caminhos das memórias que ENTRARAM no prompt do agente neste turno. */
  usedMemories?: readonly string[]
  /** A documentação do projeto, completa (ver `buildProjectOutline`). */
  docs?: string
  /** Temas que o acervo já usa, com quantas memórias cada (para reusar em vez de inventar). */
  temas?: ReadonlyArray<{ tema: string; memorias: number }>
}

/**
 * O que o modelo vê.
 *
 * A ordem não é estética. O índice vem PRIMEIRO porque a primeira pergunta é
 * "isso já está salvo?", e essa pergunta só existe se a lista chegar antes;
 * logo depois vem o que o agente já tinha em mãos (memórias injetadas e docs),
 * que é a segunda forma de duplicar; e só então o turno. A resposta do agente
 * fica por ÚLTIMO e numa linha só — é a parte mais longa e a menos decisiva.
 */
export function buildMemoristaDigest(turn: MemoristaTurn): string {
  const memories = turn.memories.slice(0, MEMORISTA_MAX_MEMORIES)
  const calls = turn.calls.slice(0, MEMORISTA_MAX_CALLS)
  const used = (turn.usedMemories ?? []).slice(0, MEMORISTA_MAX_USED_MEMORIES)
  const docs = (turn.docs ?? '').slice(0, MEMORISTA_MAX_DOCS_CHARS)
  const answer = clamp(turn.answerText ?? '', MEMORISTA_MAX_ANSWER_CHARS)
  const omitted = turn.memories.length - memories.length
  return [
    'MEMÓRIAS JÁ SALVAS:',
    ...(memories.length === 0
      ? ['(nenhuma)']
      : memories.map((memory) => `${memory.relPath} — ${clamp(memory.title, MEMORISTA_MAX_TITLE_CHARS)}: ${clamp(memory.hook, MEMORISTA_MAX_HOOK_CHARS)}`)),
    ...(omitted > 0 ? [`(+${omitted} memórias omitidas)`] : []),
    ...(turn.temas?.length
      ? ['', 'TEMAS EXISTENTES:', turn.temas.slice(0, 40).map((t) => `${t.tema} (${t.memorias})`).join(', ')]
      : []),
    '',
    'MEMÓRIAS QUE O AGENTE JÁ TINHA NESTE TURNO:',
    ...(used.length === 0 ? ['(nenhuma)'] : used.map((relPath) => `- ${relPath}`)),
    ...(docs ? ['', 'DOCUMENTAÇÃO DO PROJETO (o que já está escrito não precisa virar memória):', docs] : []),
    '',
    'O QUE O USUÁRIO DISSE NESTE TURNO:',
    clamp(turn.userText, MEMORISTA_MAX_USER_CHARS) || '(sem texto)',
    '',
    'AÇÕES DESTE TURNO:',
    ...(calls.length === 0
      ? ['(nenhuma)']
      : calls.map((call) => `- ${call.tool}${call.detail ? `: ${clamp(call.detail, MEMORISTA_MAX_CALL_CHARS)}` : ''}`)),
    ...(answer ? ['', 'O QUE O AGENTE RESPONDEU:', answer] : [])
  ].join('\n')
}

export function buildMemoristaPrompt(turn: MemoristaTurn): string {
  return `${MEMORISTA_SYSTEM_PROMPT}\n\n---\n\n${buildMemoristaDigest(turn)}`
}

function asKind(raw: string): MemoristaKind | null {
  const value = normalize(raw)
  return (MEMORISTA_KINDS as readonly string[]).includes(value) ? (value as MemoristaKind) : null
}

/**
 * Lê a resposta do modelo.
 *
 * Falha FECHADA por linha: o que não casa com o formato é descartado em
 * silêncio, nunca vira uma memória inventada. Uma linha ruim não invalida as
 * outras — o contrário desperdiçaria uma análise inteira por uma vírgula.
 *
 * `knownPaths` é a segunda barreira, e a que mais importa: COMPLEMENTA só vale
 * sobre um caminho que estava no digest (não dá para atualizar o que não se
 * viu), e NOVA sobre um caminho que já existe é rejeitada — ali o modelo devia
 * ter complementado, e criar de novo só duplicaria o assunto.
 */
export function parseMemoristaVerdict(raw: string, knownPaths: Iterable<string>): MemoristaOp[] {
  const known = new Map<string, string>()
  for (const path of knownPaths) known.set(path.toLowerCase(), path)
  const fromJson = parseJsonVerdict(raw, known)
  if (fromJson) return fromJson
  const ops: MemoristaOp[] = []
  const seen = new Set<string>()

  for (const line of (raw ?? '').split(/\r?\n/)) {
    if (ops.length >= MEMORISTA_MAX_OPS) break
    const text = line.replace(/^[`\s>*-]+/, '').trim()
    if (!text || /^OK\b/i.test(text)) continue

    const create = /^NOVA\s*\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]+)\|(.+)$/i.exec(text)
    if (create) {
      const [, rawKind, rawPath, rawTitle, rawHook, rawFact] = create
      const type = asKind(rawKind)
      const relPath = rawPath.trim().replace(/\\/g, '/').replace(/^\.\//, '')
      if (!type || !isSafeMemoryPath(relPath)) continue
      // Caminho que já existe: o modelo devia ter complementado. Criar aqui
      // seria uma proposta em conflito garantida no serviço.
      if (known.has(relPath.toLowerCase()) || seen.has(relPath.toLowerCase())) continue
      const title = clamp(rawTitle, MEMORISTA_MAX_TITLE_CHARS)
      const hook = clamp(rawHook, MEMORISTA_MAX_HOOK_CHARS)
      const fact = clamp(rawFact, MEMORISTA_MAX_FACT_CHARS)
      if (!title || !hook || !fact) continue
      seen.add(relPath.toLowerCase())
      ops.push({ kind: 'create', relPath, type, title, hook, fact })
      continue
    }

    const update = /^COMPLEMENTA\s*\|([^|]+)\|(.+)$/i.exec(text)
    if (update) {
      const [, rawPath, rawFact] = update
      const relPath = known.get(rawPath.trim().replace(/\\/g, '/').toLowerCase())
      if (!relPath || seen.has(relPath.toLowerCase())) continue
      const fact = clamp(rawFact, MEMORISTA_MAX_FACT_CHARS)
      if (!fact) continue
      seen.add(relPath.toLowerCase())
      ops.push({ kind: 'update', relPath, fact })
    }
  }
  return ops
}

function textList(raw: unknown, max: number): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = [...new Set(raw.filter((x): x is string => typeof x === 'string').map((x) => clamp(x, MEMORISTA_MAX_LIST_ITEM_CHARS)).filter(Boolean))]
  return out.length ? out.slice(0, max) : undefined
}

/** Só caminhos que estavam no digest (não se liga ao que não se viu). */
function knownList(raw: unknown, known: ReadonlyMap<string, string>, self?: string): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw
    .filter((x): x is string => typeof x === 'string')
    .map((x) => known.get(x.trim().replace(/\\/g, '/').toLowerCase()))
    .filter((x): x is string => !!x && x.toLowerCase() !== self?.toLowerCase())
  return out.length ? [...new Set(out)] : undefined
}

const TEMA_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * A resposta em JSON (layout novo). `null` quando não há JSON — aí vale o formato antigo
 * em linhas. Mesma régua do formato antigo: falha FECHADA por operação, caminho validado,
 * COMPLEMENTA só sobre caminho conhecido, NOVA nunca sobre caminho existente.
 */
function parseJsonVerdict(raw: string, known: ReadonlyMap<string, string>): MemoristaOp[] | null {
  const json = /\{[\s\S]*\}/.exec(raw ?? '')?.[0]
  if (!json) return null
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return null
  }
  const list = (data as { operacoes?: unknown })?.operacoes
  if (!Array.isArray(list)) return null
  const ops: MemoristaOp[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (ops.length >= MEMORISTA_MAX_OPS) break
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const str = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
    const op = normalize(str('op'))
    if (op === 'nova') {
      const type = asKind(str('categoria'))
      const relPath = str('caminho').trim().replace(/\\/g, '/').replace(/^\.\//, '')
      if (!type || !isSafeMemoryPath(relPath)) continue
      if (known.has(relPath.toLowerCase()) || seen.has(relPath.toLowerCase())) continue
      const title = clamp(str('titulo'), MEMORISTA_MAX_TITLE_CHARS)
      const hook = clamp(str('gancho'), MEMORISTA_MAX_HOOK_CHARS)
      const fact = clamp(str('fato'), MEMORISTA_MAX_FACT_CHARS)
      if (!title || !hook || !fact) continue
      const tema = normalize(str('tema')).replace(/\s+/g, '-')
      const imp = Number(o.importancia)
      seen.add(relPath.toLowerCase())
      ops.push({
        kind: 'create', relPath, type, title, hook, fact,
        ...(TEMA_SLUG.test(tema) ? { tema } : {}),
        ...(Number.isInteger(imp) && imp >= 1 && imp <= 5 ? { importancia: imp } : {}),
        ...(textList(o.gatilhos, MEMORISTA_MAX_GATILHOS) ? { gatilhos: textList(o.gatilhos, MEMORISTA_MAX_GATILHOS) } : {}),
        ...(textList(o.termos, MEMORISTA_MAX_TERMOS) ? { termos: textList(o.termos, MEMORISTA_MAX_TERMOS) } : {}),
        ...(clamp(str('contexto'), MEMORISTA_MAX_HOOK_CHARS) ? { contexto: clamp(str('contexto'), MEMORISTA_MAX_HOOK_CHARS) } : {}),
        ...(knownList(o.contradiz, known) ? { contradiz: knownList(o.contradiz, known) } : {}),
        ...(knownList(o.relacionadas, known) ? { relacionadas: knownList(o.relacionadas, known) } : {})
      })
      continue
    }
    if (op === 'complementa') {
      const relPath = known.get(str('caminho').trim().replace(/\\/g, '/').toLowerCase())
      if (!relPath || seen.has(relPath.toLowerCase())) continue
      const fact = clamp(str('fato'), MEMORISTA_MAX_FACT_CHARS)
      if (!fact) continue
      seen.add(relPath.toLowerCase())
      ops.push({
        kind: 'update', relPath, fact,
        ...(textList(o.gatilhos, MEMORISTA_MAX_GATILHOS) ? { gatilhos: textList(o.gatilhos, MEMORISTA_MAX_GATILHOS) } : {}),
        ...(textList(o.termos, MEMORISTA_MAX_TERMOS) ? { termos: textList(o.termos, MEMORISTA_MAX_TERMOS) } : {}),
        ...(knownList(o.contradiz, known, relPath) ? { contradiz: knownList(o.contradiz, known, relPath) } : {})
      })
    }
  }
  return ops
}

/** O que o app sabe na hora de gravar e o modelo não precisa dizer. */
export interface MemoryWriteContext {
  /** Agora (ms). Vira `criada`/`modificada` no cabeçalho (D43). */
  now: number
  /** Nome do projeto da conversa (pasta do cwd), para o `contexto` (D34). */
  project?: string
}

/**
 * O corpo do arquivo novo.
 *
 * Mesmo esqueleto do curador (front-matter + título + fato), porque é o formato
 * que o acervo já tem e que o índice sabe ler. `type` guarda a categoria da
 * régua: é o que permite, depois, olhar só as instruções ou só as preferências.
 */
export function buildMemoryBody(op: Extract<MemoristaOp, { kind: 'create' }>, ctx?: MemoryWriteContext): string {
  const slug = op.relPath.split('/').at(-1)!.replace(/\.md$/i, '')
  const base = [
    '---',
    `name: ${slug}`,
    `description: ${op.hook}`,
    'metadata:',
    `  type: ${op.type}`,
    '---',
    `# ${op.title}`,
    op.fact,
    ''
  ].join('\n')
  if (!ctx) return base
  // Layout novo (D43, D48): o cabeçalho para ACHAR; o corpo acima segue completo (D49).
  // Sem `tema` declarado, vale a pasta do caminho — a mesma regra das fichas da busca.
  const day = dataCabecalho(ctx.now)
  const contexto = [ctx.project, op.contexto].filter(Boolean).join(' — ')
  return comCampos(base, {
    tema: op.tema ?? (op.relPath.includes('/') ? op.relPath.split('/')[0] : undefined),
    criada: day,
    modificada: day,
    importancia: op.importancia ? String(op.importancia) : undefined,
    contexto: contexto || undefined,
    gatilhos: op.gatilhos,
    termos: op.termos,
    contradiz: op.contradiz,
    relacionadas: op.relacionadas
  })
}

/**
 * O corpo do arquivo que já existe, com o fato novo no fim.
 *
 * Nunca apaga nem reescreve o que estava lá: a memória antiga foi curada por
 * alguém (às vezes pelo próprio usuário), e um observador automático não tem
 * como saber o que pode sumir. Devolve `null` quando o fato já está no corpo —
 * sem isso, o mesmo assunto voltando em dois turnos viraria duas revisões com o
 * mesmo texto.
 */
export function appendFact(
  body: string,
  fact: string,
  ctx?: MemoryWriteContext & Pick<MemoristaExtras, 'gatilhos' | 'termos' | 'contradiz'>
): string | null {
  const current = body ?? ''
  if (normalize(current).includes(normalize(fact))) return null
  const appended = `${current.trimEnd()}\n${fact.trim()}\n`
  if (!ctx) return appended
  // Versão nova da mesma memória: marca a modificação e soma os gatilhos/termos novos aos
  // que já existiam (sem repetir), dentro dos tetos. Nada do que estava lá some.
  const old = lerCampos(current)
  const merge = (a: string[] | undefined, b: string[] | undefined, max: number): string[] | undefined => {
    if (!b?.length) return undefined
    const seen = new Set<string>()
    return [...(a ?? []), ...b].filter((x) => !seen.has(normalize(x)) && seen.add(normalize(x))).slice(0, max)
  }
  return comCampos(appended, {
    // `criada` não: a memória é antiga e a data certa está no banco — o bibliotecário a
    // completa de lá (D42). Escrever "hoje" aqui seria inventar a idade dela.
    modificada: dataCabecalho(ctx.now),
    gatilhos: merge(old.gatilhos, ctx.gatilhos, MEMORISTA_MAX_GATILHOS + 2),
    termos: merge(old.termos, ctx.termos, MEMORISTA_MAX_TERMOS),
    contradiz: merge(old.contradiz, ctx.contradiz, 20)
  })
}
