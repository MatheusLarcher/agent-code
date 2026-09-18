import { noul } from '@typesafe-ai/sdk'
import { askTypeSafe, typeSafeApiKey, typeSafeEnabled, typeSafeMinConfidence, type AskTypeSafeOptions } from './client'

/**
 * O gate que decide se vale gastar um LLM para gravar memória.
 *
 * Hoje o memorista consulta um modelo de conversa ao fim de TODO turno, e a
 * esmagadora maioria devolve "OK, nada a guardar". Esta pergunta binária ao Jev
 * custa ~100ms e alguns tokens; ela roda sempre, e o modelo caro só roda quando
 * ela diz sim.
 *
 * Uma regra que não pode ser esquecida em nenhum chamador: **ausência de
 * decisão não é "não"**. Sem chave, desligado, timeout ou erro devolvem `null`,
 * e `null` significa "siga como antes" — o memorista volta a decidir sozinho.
 * Uma falha no TypeSafe jamais pode virar "o app parou de salvar memória".
 */

/**
 * O que o gate vê. Só texto — nada daqui vira escrita, e tudo é cortado antes
 * de sair da máquina.
 */
export interface MemoryGateInput {
  /** A pergunta do usuário que abriu o turno. */
  userText: string
  /** A resposta final do agente. Ausente no gate da mensagem do usuário, que
   *  roda ANTES de existir resposta alguma. */
  answerText?: string
  /** Os caminhos das memórias que entraram no prompt deste turno. */
  usedMemories?: readonly string[]
  /** `caminho — título: gancho` de TODAS as memórias do acervo. */
  memoryHeaders?: readonly string[]
  /** O índice do docs/ (ver `buildDocsIndex`), nunca o docs completo. */
  docsIndex?: string
}

/**
 * Tetos do `state`. O limite do Jev é 32k TOKENS.
 *
 * A conta do PIOR caso, somando os tetos abaixo:
 *
 * ```
 *   4.000  pergunta_do_usuario
 *   6.000  resposta_do_agente
 *   2.000  memorias_usadas_neste_turno   (10 × 200)
 *  24.000  memorias_ja_salvas            (120 × 200)
 *  30.000  indice_do_docs
 *  ------
 *  66.000  caracteres
 * ```
 *
 * Um comentário antigo aqui dizia "bem menos de 60k caracteres (~15k tokens)".
 * Estava errado nos dois números, e o teste não pegava porque exercitava
 * cabeçalhos de ~26 caracteres, não os 200 do limite. Em português, 66k
 * caracteres ficam na faixa de 17k–22k tokens: cabe nos 32k, mas a folga é de
 * ~1,5x, não a margem confortável que o texto anterior sugeria. Quem mexer em
 * qualquer teto daqui precisa refazer esta conta — um `state` recusado por
 * tamanho é uma decisão perdida em TODO turno, e a falha degrada em silêncio.
 */
export const MEMORY_GATE_MAX_USER_CHARS = 4_000
export const MEMORY_GATE_MAX_ANSWER_CHARS = 6_000
export const MEMORY_GATE_MAX_HEADERS = 120
export const MEMORY_GATE_MAX_HEADER_CHARS = 200
export const MEMORY_GATE_MAX_USED = 10
/** Cada caminho de memória usada também é cortado: sem isto o `state` não teria
 *  teto nenhum nesse campo, e a conta acima seria uma estimativa, não um limite. */
export const MEMORY_GATE_MAX_USED_CHARS = 200
export const MEMORY_GATE_MAX_DOCS_INDEX_CHARS = 30_000

/** O teto que a conta acima produz. Exportado para o teste manter os dois em dia. */
export const MEMORY_GATE_MAX_STATE_CHARS =
  MEMORY_GATE_MAX_USER_CHARS +
  MEMORY_GATE_MAX_ANSWER_CHARS +
  MEMORY_GATE_MAX_USED * MEMORY_GATE_MAX_USED_CHARS +
  MEMORY_GATE_MAX_HEADERS * MEMORY_GATE_MAX_HEADER_CHARS +
  MEMORY_GATE_MAX_DOCS_INDEX_CHARS

export const MEMORY_GATE_QUESTION =
  'Este turno contém algo que merece virar MEMÓRIA de longo prazo do usuário — instrução de como trabalhar, ' +
  'preferência, conhecimento de domínio que ele informou, decisão com motivo, fato de infraestrutura ou correção ' +
  'explícita? Responda não quando for pedido de tarefa, estado passageiro, debug que o agente resolveu sozinho, ' +
  'algo que já está no código, algo que o ÍNDICE DO DOCS mostra documentado, ou algo que as MEMÓRIAS JÁ SALVAS já cobrem.'

/** Descrições dos dois lados: o Jev calibra melhor com o que cada resposta significa. */
const MEMORY_GATE_CRITERIA = {
  true: 'Há um fato novo e durável que vai mudar o que o agente faz numa conversa futura.',
  false: 'Nada aqui sobrevive a este turno, ou já está salvo/documentado.'
} as const

function clamp(text: string, max: number): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/**
 * O `state` da pergunta.
 *
 * Todos os campos são obrigatórios (vazios quando não há valor) e todos são
 * JSON puro: é o que o `EntryType` do SDK aceita, e é o que permite mandar o
 * estado ROTULADO em vez de emendado num texto só — o Jev distingue melhor a
 * pergunta do usuário da resposta do agente quando elas chegam separadas.
 */
export type MemoryGateState = {
  pergunta_do_usuario: string
  resposta_do_agente: string
  memorias_usadas_neste_turno: string[]
  memorias_ja_salvas: string[]
  memorias_ja_salvas_omitidas: number
  indice_do_docs: string
}

export function buildMemoryGateState(input: MemoryGateInput): MemoryGateState {
  const headers = (input.memoryHeaders ?? []).slice(0, MEMORY_GATE_MAX_HEADERS)
  return {
    pergunta_do_usuario: clamp(input.userText, MEMORY_GATE_MAX_USER_CHARS) || '(sem texto)',
    resposta_do_agente: clamp(input.answerText ?? '', MEMORY_GATE_MAX_ANSWER_CHARS),
    memorias_usadas_neste_turno: (input.usedMemories ?? [])
      .slice(0, MEMORY_GATE_MAX_USED)
      .map((relPath) => clamp(relPath, MEMORY_GATE_MAX_USED_CHARS)),
    memorias_ja_salvas: headers.map((header) => clamp(header, MEMORY_GATE_MAX_HEADER_CHARS)),
    memorias_ja_salvas_omitidas: Math.max(0, (input.memoryHeaders ?? []).length - headers.length),
    indice_do_docs: (input.docsIndex ?? '').slice(0, MEMORY_GATE_MAX_DOCS_INDEX_CHARS)
  }
}

/**
 * O gate está de pé nesta máquina? Só com o recurso ligado E com chave.
 *
 * Existe para o chamador não pagar a varredura do docs/ e a montagem do índice
 * antes de descobrir que não há a quem perguntar.
 */
export async function memoryGateActive(): Promise<boolean> {
  try {
    if (!typeSafeEnabled()) return false
    return (await typeSafeApiKey()) !== null
  } catch {
    return false
  }
}

/**
 * O veredito: `true` salvar, `false` não gastar o modelo, `null` SEM decisão.
 *
 * `noul` devolve um único número: P(sim), de 0 a 1. Ele **não é confiança** —
 * `noul = 0,05` é um "não" fortíssimo, não uma resposta incerta. Por isso o
 * corte é `noul >= limiar` e não `confiança >= limiar`; a confiança desta
 * resposta binária, se algum dia for preciso, é `Math.abs(noul - 0.5) * 2`.
 *
 * O limiar é `typeSafeMinConfidence()` (0,6 por padrão), e aqui ele cabe: a
 * pergunta é binária, 0,5 é o acaso, e um piso absoluto tem significado —
 * diferente da seleção de memórias, onde a massa se espalha por N opções.
 *
 * Nunca lança.
 */
export async function shouldSaveMemory(
  input: MemoryGateInput,
  options: AskTypeSafeOptions = {}
): Promise<boolean | null> {
  try {
    const answers = await askTypeSafe(
      {
        state: buildMemoryGateState(input),
        questions: { salvar: noul(MEMORY_GATE_QUESTION, MEMORY_GATE_CRITERIA) }
      },
      options
    )
    if (!answers) return null
    const yes = answers.salvar.noul
    if (typeof yes !== 'number' || !Number.isFinite(yes)) return null
    return yes >= typeSafeMinConfidence()
  } catch (error) {
    // Mesma regra do resto da pasta: só a mensagem, nunca o `state` — ele
    // carrega o conteúdo da conversa.
    console.error(`[typesafe] gate de memória descartado: ${(error as Error)?.message ?? error}`)
    return null
  }
}
