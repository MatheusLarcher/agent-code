import { choice } from '@typesafe-ai/sdk'
import {
  listMemoryFiles,
  memoryContextBlock,
  rankMemoriesByQuery,
  readMemoryBody,
  redactMemorySecrets,
  type MemoryFile
} from '../memoryIndex'
import { askTypeSafe, typeSafeApiKey, typeSafeEnabled, type AskTypeSafeOptions } from './client'

/**
 * Quem escolhe as memórias que vão para o prompt.
 *
 * Antes o app mandava o índice inteiro (MEMORY.md, ~227 cabeçalhos) em toda
 * conversa e mais três trechos cortados em 1600 caracteres, escolhidos por
 * casamento de palavra. Aqui a decisão é do TypeSafe: uma pergunta `choice` com
 * os CABEÇALHOS de todas as candidatas, e de 0 a 3 memórias voltam INTEIRAS,
 * relidas do disco na hora. Cabeçalho de memória não escolhida não entra no
 * prompt por caminho nenhum.
 */

/** Teto de opções que uma pergunta `choice` aceita. Acima disso, pré-filtro lexical. */
export const MEMORY_CHOICE_MAX_OPTIONS = 255

/**
 * Quantas MEMÓRIAS cabem na pergunta: uma a menos que o teto de opções, porque
 * o rótulo `MEMORY_SELECTION_NONE` também ocupa um lugar. Esquecer de reservá-lo
 * faria a pergunta sair com 256 rótulos e ser recusada — justamente na pasta
 * grande, onde o recurso mais importa.
 */
export const MEMORY_CHOICE_MAX_MEMORIES = MEMORY_CHOICE_MAX_OPTIONS - 1

/**
 * Teto de arquivos que o pré-filtro lexical LÊ do disco.
 *
 * `rankMemoriesByQuery` abre e lê o corpo de cada candidata de forma SÍNCRONA, e
 * este caminho roda no processo main, na frente do envio da mensagem. Sem teto,
 * uma pasta com milhares de memórias trava a UI por N leituras. `buildDynamicMemoryContext`
 * já parava em 250 pelo mesmo motivo; aqui o número precisa ser maior que
 * `MEMORY_CHOICE_MAX_OPTIONS`, senão a pergunta sairia mais curta do que o
 * `choice` aceita e o pré-filtro não filtraria nada. Passando daqui, a cauda em
 * ordem de nome é descartada — o mesmo critério (arbitrário, e assumido como
 * tal) que o caminho lexical já usava.
 */
export const MEMORY_RANK_SCAN_MAX = 500

/**
 * O rótulo que significa "nenhuma destas memórias serve".
 *
 * `choice` é escolha FORÇADA: a distribuição soma 1 entre os rótulos oferecidos,
 * então sem este rótulo o modelo é obrigado a depositar massa em alguma memória
 * mesmo quando nenhuma tem relação com a mensagem. Com 227 candidatas isso se
 * dilui e o limiar de lift filtra; com UMA memória na pasta o topo é 1,0 por
 * construção, com duas é ≥ 0,5 — e "oi" injetaria memória sempre.
 *
 * A decisão do usuário é "zero memórias quando nada é relevante", e ela só
 * funcionava por acidente estatístico. Este rótulo dá à distribuição onde
 * depositar a massa: quando ele vence, o resultado é zero memórias.
 *
 * Não colide com nenhum `relPath`: todo caminho de memória termina em `.md`
 * (ver `listMemoryFileMetadata` em memoryIndex.ts).
 */
export const MEMORY_SELECTION_NONE = '__nenhuma__'

const MEMORY_SELECTION_NONE_DESCRIPTION =
  'NENHUMA das memórias acima é necessária para responder a esta mensagem — ' +
  'cumprimento, pergunta genérica, pedido que se resolve sozinho, ou assunto que nenhuma delas cobre. ' +
  'Escolha esta opção sempre que estiver depositando probabilidade numa memória só porque é preciso escolher alguma.'

/** Quantas memórias, no máximo, entram no prompt de um turno. */
export const MEMORY_SELECTION_MAX = 3

/**
 * O corte: quantas vezes a memória precisa superar o SORTEIO ALEATÓRIO.
 *
 * Complementar ao `MEMORY_SELECTION_NONE`, não substituto dele: o lift mede a
 * candidata contra o acaso, o rótulo sentinela mede contra "nada serve". Uma
 * memória só entra quando passa nos DOIS.
 *
 * NÃO é `typeSafeMinConfidence()`, e não pode ser. `confidence`/`probabilities`
 * de um `choice` são a distribuição sobre as N opções: com N ≈ 227 a massa se
 * espalha e a melhor candidata vence por larga margem ainda marcando 0,15–0,3.
 * Um piso absoluto de 0,6 devolveria ZERO memória sempre, e o recurso pareceria
 * funcionar enquanto nunca escolhesse nada. O piso configurado fica reservado
 * para o gate `noul`, que é binário e por isso comparável a um número fixo.
 *
 * Aqui o critério não depende de N: com N candidatas o acaso é `1/N`, então a
 * memória entra quando `p * N >= MEMORY_SELECTION_MIN_LIFT`. Número inicial, a
 * calibrar contra tráfego real.
 */
export const MEMORY_SELECTION_MIN_LIFT = 8

/**
 * Teto do limiar derivado do lift, para N pequeno.
 *
 * `MIN_LIFT / N` passa de 1 quando há menos de 8 candidatas — nenhuma memória
 * poderia ser escolhida numa pasta com 5 arquivos. Com poucas opções a maioria
 * simples da distribuição já é evidência suficiente, então o limiar efetivo é
 * `min(MIN_LIFT / N, MEMORY_SELECTION_MAJORITY)`. Também a calibrar.
 */
export const MEMORY_SELECTION_MAJORITY = 0.5

/** Limiar de probabilidade para N candidatas. Exportado para o teste e para a calibração. */
export function memorySelectionThreshold(candidateCount: number): number {
  if (candidateCount <= 0) return 1
  return Math.min(MEMORY_SELECTION_MIN_LIFT / candidateCount, MEMORY_SELECTION_MAJORITY)
}

const INSTRUCTIONS =
  'Qual destas memórias persistentes do usuário é necessária para responder à mensagem abaixo? ' +
  'Cada opção é o caminho de um arquivo de memória, descrito pelo título e pelo resumo dele. ' +
  'Considere apenas relevância direta para esta mensagem. ' +
  `Se NENHUMA delas for necessária, escolha \`${MEMORY_SELECTION_NONE}\` — é uma resposta legítima e comum, ` +
  'e preferível a apontar uma memória qualquer só porque é preciso escolher alguma.'

/**
 * O recurso governa a injeção de memória nesta máquina? Só quando está ligado E
 * há chave: sem chave toda decisão viria vazia, e suprimir o catálogo sem nada
 * no lugar deixaria o modelo sem memória alguma.
 */
export async function typeSafeMemorySelectionActive(): Promise<boolean> {
  if (!typeSafeEnabled()) return false
  return (await typeSafeApiKey()) !== null
}

/** Cabeçalho de uma candidata: o que o serviço vê, e nada além disso. */
function header(file: MemoryFile): string {
  const title = file.title.trim()
  const hook = file.hook.trim()
  const text = title && hook && title !== hook ? `${title} — ${hook}` : title || hook
  return redactMemorySecrets(text).slice(0, 300)
}

/**
 * As candidatas que cabem numa pergunta `choice`. Acima do teto, corta pelo
 * score lexical que já ranqueia os trechos de hoje — o ranqueador é um só.
 */
function narrowCandidates(dir: string, query: string, files: MemoryFile[]): MemoryFile[] {
  if (files.length <= MEMORY_CHOICE_MAX_MEMORIES) return files
  // O teto de LEITURA vem antes do ranqueamento: `rankMemoriesByQuery` lê o corpo
  // de cada arquivo que recebe, de forma síncrona, no processo main.
  const scanned = files.length > MEMORY_RANK_SCAN_MAX ? files.slice(0, MEMORY_RANK_SCAN_MAX) : files
  const ranked = rankMemoriesByQuery(dir, query, scanned)
  if (ranked.length === 0) return scanned.slice(0, MEMORY_CHOICE_MAX_MEMORIES)
  const kept = ranked.slice(0, MEMORY_CHOICE_MAX_MEMORIES).map((match) => match.file)
  // O ranqueamento pula arquivo ilegível/grande demais; completa com o resto da
  // lista para a pergunta não ir mais curta do que poderia.
  if (kept.length < MEMORY_CHOICE_MAX_MEMORIES) {
    const chosen = new Set(kept.map((file) => file.relPath))
    for (const file of scanned) {
      if (kept.length >= MEMORY_CHOICE_MAX_MEMORIES) break
      if (!chosen.has(file.relPath)) kept.push(file)
    }
  }
  return kept
}

/**
 * A decisão de memória de um turno: o bloco pronto para o prompt e os caminhos
 * que o produziram.
 *
 * Os dois campos descrevem a MESMA escolha e andam juntos: `relPaths` é o que
 * entrou no prompt de verdade (memória ilegível na hora da releitura não entra
 * em nenhum dos dois), e é o que o gate do memorista precisa saber para não
 * propor de novo um fato que o agente já tinha em mãos.
 */
export interface MemorySelection {
  /** O texto injetado no prompt. `''` = a decisão foi "nenhuma memória". */
  block: string
  /** Os `relPath` escolhidos, na mesma ordem em que aparecem no bloco. */
  relPaths: readonly string[]
}

/** A decisão "nenhuma memória neste turno" — decisão legítima, não ausência dela. */
function nothingSelected(): MemorySelection {
  return { block: '', relPaths: [] }
}

/**
 * A memória deste turno, decidida pelo TypeSafe.
 *
 * - `MemorySelection` — a decisão valeu. `block` pode ser `''`: ZERO memórias é
 *   uma resposta legítima ("oi" não precisa de nenhuma), e o chamador não deve
 *   compensar com busca lexical.
 * - `null` — NÃO houve decisão (desligado, sem chave, timeout, erro, pasta
 *   ilegível). O chamador volta ao caminho lexical de sempre.
 *
 * Os três estados de antes continuam de pé, só que o "decidiu zero" agora é um
 * objeto com `block: ''` em vez da string vazia. Quem consome tem de seguir
 * distinguindo `''` de `null`: colapsar os dois devolve memória a um turno que
 * o usuário decidiu deixar sem memória.
 *
 * Nunca lança.
 */
export async function selectMemoriesWithTypeSafe(
  dir: string,
  query: string,
  options: AskTypeSafeOptions = {}
): Promise<MemorySelection | null> {
  try {
    if (!typeSafeEnabled()) return null
    const files = listMemoryFiles(dir)
    if (files.length === 0) return nothingSelected()

    const candidates = narrowCandidates(dir, query, files)
    const criteria: Record<string, string> = {}
    for (const file of candidates) criteria[file.relPath] = header(file)
    // Oferecido SEMPRE, inclusive com uma candidata só — é justamente aí que a
    // escolha forçada mais distorce.
    criteria[MEMORY_SELECTION_NONE] = MEMORY_SELECTION_NONE_DESCRIPTION

    const answers = await askTypeSafe({ state: query, questions: { memoria: choice(INSTRUCTIONS, criteria) } }, options)
    if (!answers) return null

    const probabilities = answers.memoria.probabilities as Record<string, number>
    const nonePick = probabilities[MEMORY_SELECTION_NONE]
    // Rótulo ausente na resposta = nenhuma massa em "nada serve". Não é o mesmo
    // que ele ter vencido, e não pode virar um piso inventado.
    const none = typeof nonePick === 'number' && Number.isFinite(nonePick) ? nonePick : 0
    const threshold = memorySelectionThreshold(candidates.length)
    const picked = Object.entries(probabilities)
      .filter(
        ([relPath, p]) =>
          relPath !== MEMORY_SELECTION_NONE &&
          typeof p === 'number' &&
          Number.isFinite(p) &&
          p >= threshold &&
          // O sentinela é o piso da rodada: nada que o modelo considerou MENOS
          // provável do que "nada serve" entra no prompt. Quando ele é o topo da
          // distribuição, nenhuma memória passa — que é o resultado esperado.
          p > none &&
          relPath in criteria
      )
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MEMORY_SELECTION_MAX)

    const blocks: string[] = []
    const relPaths: string[] = []
    const seen = new Set<string>()
    for (const [relPath] of picked) {
      if (seen.has(relPath)) continue
      seen.add(relPath)
      // Relida AGORA: o conteúdo do disco é o que vale, não o que foi lido para
      // ranquear ou para montar o catálogo no início da conversa.
      const body = readMemoryBody(dir, relPath)
      if (!body) continue
      blocks.push(memoryContextBlock(relPath, body))
      // Só o que virou bloco entra na lista: o gate tem de ver o que o agente
      // recebeu, não o que o serviço apontou.
      relPaths.push(relPath)
    }
    return { block: blocks.join('\n\n'), relPaths }
  } catch (error) {
    console.error(`[typesafe] seleção de memória descartada: ${(error as Error)?.message ?? error}`)
    return null
  }
}
