// Parte pura de avaliar-escolha-memorias.ts: lê os casos, calcula as métricas e
// escreve o resumo. Sem rede e sem disco — o executor só passa os dados.

/**
 * Um conceito esperado: um caminho, ou um grupo de memórias que dizem a mesma
 * coisa (`{ umaDe: [...] }`) — qualquer uma delas basta.
 */
export type Esperado = string | { umaDe: string[] }

export interface Caso {
  id: string
  pedido: string
  /** Caminhos relativos à pasta de memórias, com "/" (ex.: "trabalho/deploy.md"), ou grupos umaDe. Vazio = o certo é não escolher nada. */
  esperadas: Esperado[]
  /** Escolher conta como acerto na precisão; não escolher não faz falta (fora da cobertura). */
  aceitaveis: string[]
  /** Resumo da conversa até aqui, opcional: vai ao modelo como no app. */
  conversa?: string
  nota?: string
}

export interface Execucao {
  caso: string
  seletor: string
  repeticao: number
  ms: number
  /** true = o seletor não decidiu (tempo esgotado, erro, resposta sem JSON); no app cairia na busca lexical. */
  falhou: boolean
  erro?: string
  /** O que o seletor escolheu, já sem as memórias "sempre" (que entram de qualquer jeito). */
  escolhidas: string[]
  /** O que caberia no bloco do turno (teto de caracteres do app), também sem as "sempre". */
  entregues: string[]
  precisao: number | null
  cobertura: number | null
  /** Nota única do pedido (F1 de precisão e cobertura); null quando o seletor falhou. */
  nota: number | null
  /** Quantas escolhidas eram extras (fora das esperadas e das aceitáveis), por veredito do juiz. */
  extras: ContagemExtras
  /** Veredito do juiz por memória extra (ausente = juiz desligado ou falhou). */
  vereditos?: Record<string, { veredito: Veredito; motivo: string; doCache: boolean }>
  /** Caracteres do bloco de memórias que iria no turno (as `entregues`, já com o teto do app). */
  caracteres?: number
  /** Custo e tempo do seletor. */
  custoUsd?: number
  /** Tokens de entrada do pedido ao modelo (com cache); 0 no seletor sem IA. A medida principal de custo. */
  tokensEntrada?: number
  /** Do `ms`: quanto foi do ordenador local (embeddings + RRF) e quanto do modelo. Ausentes quando não se aplicam. */
  msOrdenador?: number
  msModelo?: number
  /** Custo e tempo do juiz das extras, à parte do seletor (cache = 0). */
  custoJuizUsd?: number
  msJuiz?: number
}

/** O que o juiz diz de uma memória extra: ajuda, tanto faz ou atrapalha a resposta. */
export type Veredito = 'util' | 'neutra' | 'atrapalha'

export interface ContagemExtras {
  util: number
  neutra: number
  atrapalha: number
  /** Extra sem veredito (juiz desligado ou falhou): conta como erro, como antes do juiz. */
  semJuiz: number
}

export interface LinhaResumo {
  seletor: string
  execucoes: number
  falhas: number
  msMediano: number | null
  msMin: number | null
  msMax: number | null
  nota: number | null
  precisao: number | null
  cobertura: number | null
  /** % das repetições 2..N que repetiram a escolha da 1ª, média dos casos; null com 1 repetição. */
  estabilidade: number | null
  mediaEscolhidas: number | null
  /** Médias por pedido das extras de cada veredito. */
  extras: { util: number | null; neutra: number | null; atrapalha: number | null; semJuiz: number | null }
  mediaCaracteres: number | null
  /** Média de tokens de entrada por pedido (inclui as falhas: o pedido foi pago). */
  tokensEntradaMedio: number | null
  msOrdenadorMediano: number | null
  msModeloMediano: number | null
  custoUsd: number | null
  custoJuizUsd: number | null
  msJuizMediano: number | null
}

/** Valida o arquivo de casos (fronteira: o arquivo vem de fora). Aceita `{ "casos": [...] }` ou a lista direto. */
export function lerCasos(raw: unknown): Caso[] {
  const lista = Array.isArray(raw) ? raw : (raw as { casos?: unknown } | null)?.casos
  if (!Array.isArray(lista) || lista.length === 0) throw new Error('casos.json precisa de uma lista "casos" com pelo menos 1 caso')
  const ids = new Set<string>()
  return lista.map((item, i) => {
    const c = item as Record<string, unknown>
    const onde = `caso #${i + 1}`
    if (!c || typeof c !== 'object') throw new Error(`${onde}: não é um objeto`)
    const id = typeof c.id === 'string' && c.id.trim() ? c.id.trim() : `caso-${i + 1}`
    if (ids.has(id)) throw new Error(`${onde}: id repetido "${id}"`)
    ids.add(id)
    if (typeof c.pedido !== 'string' || !c.pedido.trim()) throw new Error(`${onde} (${id}): "pedido" vazio`)
    const { esperadas, aceitaveis } = lerEsperadas(c.esperadas, c.aceitaveis, `${onde} (${id})`)
    const conversa = typeof c.conversa === 'string' && c.conversa.trim() ? c.conversa : undefined
    const nota = typeof c.nota === 'string' ? c.nota : undefined
    return { id, pedido: c.pedido, esperadas, aceitaveis, ...(conversa ? { conversa } : {}), ...(nota ? { nota } : {}) }
  })
}

const listaDeTextos = (x: unknown): x is string[] => Array.isArray(x) && x.every((p) => typeof p === 'string')
const limpar = (xs: string[]): string[] => [...new Set(xs.map(normalizarCaminho).filter(Boolean))]

/** Valida esperadas (strings ou `{ umaDe }`) e aceitaveis; cada caminho só pode aparecer em um lugar. */
function lerEsperadas(rawEsperadas: unknown, rawAceitaveis: unknown, onde: string): { esperadas: Esperado[]; aceitaveis: string[] } {
  const formato = `"esperadas" precisa ser uma lista de caminhos ou de grupos {"umaDe": [caminhos]} (pode ser vazia)`
  if (!Array.isArray(rawEsperadas)) throw new Error(`${onde}: ${formato}`)
  const visto = new Set<string>()
  const marcar = (p: string): void => {
    if (visto.has(p)) throw new Error(`${onde}: "${p}" aparece em mais de um lugar (esperadas/grupos/aceitaveis)`)
    visto.add(p)
  }
  const esperadas: Esperado[] = []
  for (const item of rawEsperadas) {
    if (typeof item === 'string') {
      const p = normalizarCaminho(item)
      if (!p || visto.has(p)) continue // repetida como string solta: só ignora, como antes
      marcar(p)
      esperadas.push(p)
      continue
    }
    const membros = (item as { umaDe?: unknown } | null)?.umaDe
    if (!item || typeof item !== 'object' || !listaDeTextos(membros)) throw new Error(`${onde}: ${formato}`)
    const grupo = limpar(membros)
    if (grupo.length === 0) throw new Error(`${onde}: grupo "umaDe" vazio`)
    grupo.forEach(marcar)
    esperadas.push(grupo.length === 1 ? grupo[0] : { umaDe: grupo })
  }
  if (rawAceitaveis !== undefined && !listaDeTextos(rawAceitaveis)) throw new Error(`${onde}: "aceitaveis" precisa ser uma lista de caminhos`)
  const aceitaveis = limpar(rawAceitaveis ?? [])
  aceitaveis.forEach(marcar)
  return { esperadas, aceitaveis }
}

export const membros = (e: Esperado): string[] => (typeof e === 'string' ? [e] : e.umaDe)

/** Todos os caminhos citados no caso (esperadas, membros de grupos e aceitáveis). */
export function caminhosDoCaso(caso: Pick<Caso, 'esperadas' | 'aceitaveis'>): string[] {
  return [...caso.esperadas.flatMap(membros), ...caso.aceitaveis]
}

/** Tira os conceitos que têm um membro "sempre": esses entram de qualquer jeito, então ficam fora da conta. */
export function semConceitosSempre(esperadas: readonly Esperado[], sempre: ReadonlySet<string>): Esperado[] {
  return esperadas.filter((e) => !membros(e).some((p) => sempre.has(p)))
}

export function normalizarCaminho(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

/** As escolhidas que não são esperadas (nem membro de grupo) nem aceitáveis: o que o juiz avalia. */
export function extrasDe(escolhidas: readonly string[], esperadas: readonly Esperado[], aceitaveis: readonly string[] = []): string[] {
  const conhecidas = new Set([...esperadas.flatMap(membros), ...aceitaveis])
  return [...new Set(escolhidas)].filter((p) => !conhecidas.has(p))
}

export interface Pontuacao {
  precisao: number | null
  cobertura: number | null
  nota: number
  extras: ContagemExtras
}

/**
 * Nota do pedido = F1 de precisão e cobertura.
 * - Acertos da precisão: conceitos esperados atingidos (grupo umaDe conta 1) +
 *   aceitáveis escolhidas + extras que o juiz achou "util".
 * - Erros: extras "atrapalha" e extras sem veredito (juiz desligado/falhou).
 * - Fora da conta: extras "neutra" e membros a mais de um grupo já atingido.
 * - Cobertura: só sobre as esperadas (aceitáveis e extras não fazem falta).
 * Esperado vazio: cobertura 1; nada que conte escolhido dá nota 1. Esperado
 * cheio e nada esperado escolhido: cobertura 0, nota 0 (precisão null se nada contou).
 */
export function pontuar(
  escolhidas: readonly string[],
  esperadas: readonly Esperado[],
  aceitaveis: readonly string[] = [],
  vereditos: Readonly<Record<string, Veredito>> = {}
): Pontuacao {
  const aceitas = new Set(aceitaveis)
  const conceitoDe = new Map<string, number>()
  esperadas.forEach((e, i) => membros(e).forEach((p) => conceitoDe.set(p, i)))
  const atingidos = new Set<number>()
  const extras: ContagemExtras = { util: 0, neutra: 0, atrapalha: 0, semJuiz: 0 }
  let aceitasEscolhidas = 0
  for (const p of new Set(escolhidas)) {
    const i = conceitoDe.get(p)
    if (i !== undefined) atingidos.add(i)
    else if (aceitas.has(p)) aceitasEscolhidas++
    else if (vereditos[p]) extras[vereditos[p]]++
    else extras.semJuiz++
  }
  const acertos = atingidos.size + aceitasEscolhidas + extras.util
  const erros = extras.atrapalha + extras.semJuiz
  const contam = acertos + erros
  const vazio = esperadas.length === 0
  const precisao = contam > 0 ? acertos / contam : vazio ? 1 : null
  const cobertura = vazio ? 1 : atingidos.size / esperadas.length
  const nota = precisao === null || precisao + cobertura === 0 ? 0 : (2 * precisao * cobertura) / (precisao + cobertura)
  return { precisao, cobertura, nota, extras }
}

function mediana(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function media(xs: Array<number | null | undefined>): number | null {
  const v = xs.filter((x): x is number => typeof x === 'number')
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}

const chave = (xs: readonly string[]): string => [...xs].sort().join('\n')

/** Por caso: % das repetições 2..N cuja escolha (como conjunto) é igual à da 1ª. Falha conta como escolha diferente. */
export function estabilidadeDoCaso(execs: readonly Execucao[]): number | null {
  const ordem = [...execs].sort((a, b) => a.repeticao - b.repeticao)
  if (ordem.length < 2) return null
  const primeira = ordem[0].falhou ? null : chave(ordem[0].escolhidas)
  const iguais = ordem.slice(1).filter((e) => !e.falhou && primeira !== null && chave(e.escolhidas) === primeira).length
  return iguais / (ordem.length - 1)
}

export function resumir(execucoes: readonly Execucao[], seletores: readonly string[]): LinhaResumo[] {
  return seletores.map((seletor) => {
    const minhas = execucoes.filter((e) => e.seletor === seletor)
    const validas = minhas.filter((e) => !e.falhou)
    const tempos = minhas.map((e) => e.ms)
    const casos = [...new Set(minhas.map((e) => e.caso))]
    const temposJuiz = minhas.map((e) => e.msJuiz).filter((x): x is number => typeof x === 'number')
    return {
      seletor,
      execucoes: minhas.length,
      falhas: minhas.length - validas.length,
      msMediano: mediana(tempos),
      msMin: tempos.length ? Math.min(...tempos) : null,
      msMax: tempos.length ? Math.max(...tempos) : null,
      nota: media(validas.map((e) => e.nota)),
      precisao: media(validas.map((e) => e.precisao)),
      cobertura: media(validas.map((e) => e.cobertura)),
      estabilidade: media(casos.map((c) => estabilidadeDoCaso(minhas.filter((e) => e.caso === c)))),
      mediaEscolhidas: media(validas.map((e) => e.escolhidas.length)),
      extras: {
        util: media(validas.map((e) => e.extras.util)),
        neutra: media(validas.map((e) => e.extras.neutra)),
        atrapalha: media(validas.map((e) => e.extras.atrapalha)),
        semJuiz: media(validas.map((e) => e.extras.semJuiz))
      },
      mediaCaracteres: media(validas.map((e) => e.caracteres)),
      tokensEntradaMedio: media(minhas.map((e) => e.tokensEntrada)),
      msOrdenadorMediano: mediana(numeros(minhas.map((e) => e.msOrdenador))),
      msModeloMediano: mediana(numeros(minhas.map((e) => e.msModelo))),
      custoUsd: soma(minhas.map((e) => e.custoUsd)),
      custoJuizUsd: soma(minhas.map((e) => e.custoJuizUsd)),
      msJuizMediano: mediana(temposJuiz)
    }
  })
}

const numeros = (xs: Array<number | undefined>): number[] => xs.filter((x): x is number => typeof x === 'number')

/** Inteiro com ponto de milhar (60.123), sem depender do idioma do sistema. */
const tokens = (x: number | null): string => (x === null ? '—' : String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'))

function soma(xs: Array<number | undefined>): number | null {
  const v = xs.filter((x): x is number => typeof x === 'number')
  return v.length ? v.reduce((a, b) => a + b, 0) : null
}

const pct = (x: number | null): string => (x === null ? '—' : `${Math.round(x * 100)}%`)
const seg = (ms: number | null): string => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`)
/** O ordenador local leva dezenas de ms: em segundos viraria "0.0 s". */
const msOuSeg = (ms: number | null): string => (ms === null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : seg(ms))

export interface Cabecalho {
  quando: string
  pasta: string
  totalMemorias: number
  sempre: string[]
  repeticoes: number
  modelos: Record<string, string>
  /** Modelo do juiz das extras, ou null com --sem-juiz. */
  juiz?: string | null
}

const num = (x: number | null, casas = 1): string => (x === null ? '—' : x.toFixed(casas))
const usd = (x: number | null): string => (x === null ? '—' : `US$ ${x.toFixed(4)}`)

export function resumoMarkdown(cab: Cabecalho, linhas: readonly LinhaResumo[], execucoes: readonly Execucao[], casos: readonly Caso[]): string {
  const comJuiz = !!cab.juiz
  const out: string[] = [
    `# Escolha de memórias — ${cab.quando}`,
    '',
    `- Pasta: \`${cab.pasta}\` (${cab.totalMemorias} memórias)`,
    `- Casos: ${casos.length} · repetições por seletor: ${cab.repeticoes}`,
    `- Modelos: ${Object.entries(cab.modelos).map(([s, m]) => `${s} = ${m}`).join(', ') || '—'}`,
    `- Juiz das extras: ${comJuiz ? cab.juiz : 'desligado (extras contam como erro)'}`,
    `- Memórias "sempre" (entram de qualquer jeito, fora da conta): ${cab.sempre.length ? cab.sempre.map((p) => `\`${p}\``).join(', ') : 'nenhuma'}`,
    '',
    '## Qualidade por seletor',
    '',
    '| Seletor | Nota (F1) | Cobertura | Precisão | Memórias por pedido | Extras úteis | Extras neutras | Extras que atrapalham | Extras sem juiz | Caracteres por pedido | Mesma escolha nas repetições | Execuções | Falhas |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|'
  ]
  for (const l of linhas) {
    const x = l.extras
    out.push(
      `| ${l.seletor} | ${pct(l.nota)} | ${pct(l.cobertura)} | ${pct(l.precisao)} | ${num(l.mediaEscolhidas)} | ${num(x.util)} | ${num(x.neutra)} | ${num(x.atrapalha)} | ${num(x.semJuiz)} | ${num(l.mediaCaracteres, 0)} | ${pct(l.estabilidade)} | ${l.execucoes} | ${l.falhas} |`
    )
  }
  out.push(
    '',
    '## Custo e tempo por seletor',
    '',
    '| Seletor | Tokens de entrada por pedido | Tempo mediano | Faixa | Tempo do ordenador | Tempo do modelo | Custo do seletor (US$) | Tempo mediano do juiz | Custo do juiz (US$) |',
    '|---|---|---|---|---|---|---|---|---|'
  )
  for (const l of linhas) {
    const faixa = l.msMin === null ? '—' : `${seg(l.msMin)} – ${seg(l.msMax)}`
    out.push(
      `| ${l.seletor} | ${tokens(l.tokensEntradaMedio)} | ${seg(l.msMediano)} | ${faixa} | ${msOuSeg(l.msOrdenadorMediano)} | ${seg(l.msModeloMediano)} | ${usd(l.custoUsd)} | ${seg(l.msJuizMediano)} | ${usd(l.custoJuizUsd)} |`
    )
  }
  out.push(
    '',
    'Nota (F1): uma nota só por pedido, que junta precisão e cobertura; a tabela mostra a média dos pedidos.',
    'Cobertura: das esperadas, quantas foram escolhidas. Precisão: das escolhidas que contam, quantas ajudam.',
    'Contam como acerto na precisão: as esperadas, as aceitáveis e as extras que o juiz achou úteis. Contam como erro: as extras que atrapalham e as extras sem veredito. Extras neutras ficam fora da conta.',
    'Extras: escolhidas fora das esperadas e das aceitáveis; os números são a média por pedido.',
    'Grupo "uma de (...)": memórias que dizem a mesma coisa; conta como 1 esperada, coberta se qualquer uma foi escolhida, e escolher mais de uma não é erro.',
    'Esperado vazio: nada escolhido (ou só neutras) dá nota 100%. Esperado cheio e nenhuma esperada escolhida dá nota 0.',
    'Falhas ficam fora das médias (no app, cairiam na busca por palavras). Caracteres: o tamanho do bloco de memórias que iria no turno, sem as "sempre".',
    'Tokens de entrada por pedido: o que o seletor mandou ao modelo (média, contando as falhas); é a medida principal de custo. Sem IA = 0. US$ é secundário.',
    'Tempo do ordenador: a parte local (vetores + fusão) antes do modelo; tempo do modelo: o resto. "—" quando o seletor não usa a parte.',
    'Custo do juiz: só as avaliações novas; as que vieram do cache não custam nada.',
    '"Mesma escolha" só existe com 2+ repetições.',
    '',
    '## Por caso (1ª repetição)',
    ''
  )
  for (const caso of casos) {
    out.push(`### ${caso.id}`, '', `Pedido: ${caso.pedido.replace(/\s+/g, ' ').slice(0, 200)}`, '', `Esperadas: ${listaEsperadas(caso.esperadas)}`, '')
    if (caso.aceitaveis.length) out.push(`Aceitáveis: ${lista(caso.aceitaveis)}`, '')
    out.push('| Seletor | Escolhidas | Nota | Cobertura | Extras (veredito) | Tempo |', '|---|---|---|---|---|---|')
    for (const l of linhas) {
      const e = execucoes.find((x) => x.caso === caso.id && x.seletor === l.seletor && x.repeticao === 1)
      if (!e) continue
      const escolha = e.falhou ? `falhou${e.erro ? ` (${e.erro})` : ''}` : lista(e.escolhidas)
      out.push(`| ${l.seletor} | ${escolha} | ${pct(e.nota)} | ${pct(e.cobertura)} | ${listaExtras(e, caso)} | ${seg(e.ms)} |`)
    }
    out.push('')
  }
  return out.join('\n')
}

function listaExtras(e: Execucao, caso: Caso): string {
  if (e.falhou) return '—'
  const extras = extrasDe(e.escolhidas, caso.esperadas, caso.aceitaveis)
  if (!extras.length) return '(nenhuma)'
  return extras
    .map((p) => {
      const v = e.vereditos?.[p]
      return v ? `\`${p}\`: ${v.veredito} — ${v.motivo.replace(/\|/g, '/')}` : `\`${p}\`: sem juiz`
    })
    .join('<br>')
}

function lista(xs: readonly string[]): string {
  return xs.length ? xs.map((p) => `\`${p}\``).join(', ') : '(nenhuma)'
}

function listaEsperadas(xs: readonly Esperado[]): string {
  if (!xs.length) return '(nenhuma)'
  return xs.map((e) => (typeof e === 'string' ? `\`${e}\`` : `uma de (${e.umaDe.map((p) => `\`${p}\``).join(', ')})`)).join(', ')
}
