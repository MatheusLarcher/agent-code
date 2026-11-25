// Registro local das chamadas feitas ao PC do cliente: hora, sessão, ferramenta, resumo e
// resultado. Uma linha JSON por chamada, no PC do técnico. Nunca traz token, chave, texto
// digitado nem o que o PC do cliente devolveu.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { SUPORTE_SERVIDOR_REMOTO } from '../../shared/suporteRemoto'

export const PREFIXO_REMOTO = `mcp__${SUPORTE_SERVIDOR_REMOTO}__`

export interface ChamadaRegistrada {
  hora: string
  /** Começo do id da sessão: identifica sem servir para chamar. */
  sessao: string
  ferramenta: string
  resumo: string
  resultado: 'ok' | 'erro' | 'negada'
  ms?: number
}

const TAMANHO_MAXIMO = 1024 * 1024
const NA_MEMORIA = 50
const ABERTAS_MAXIMO = 500

/** Ferramentas que digitam: o texto não entra no registro, só o tamanho. */
const DIGITAM = /(?:type_text|fill|set_value|chrome_type|android_digitar|arquivo_escrever|arquivo_editar)$/
/** O argumento que resume a chamada, na ordem em que vale. */
const CAMPOS = ['comando', 'caminho', 'url', 'app', 'recurso', 'tecla', 'pasta', 'padrao', 'serial'] as const

const curto = (valor: string, max = 120): string => {
  const limpo = valor.replace(/\s+/g, ' ').trim()
  return limpo.length > max ? `${limpo.slice(0, max - 1)}…` : limpo
}

/** Resumo curto do que foi pedido. Nada de conteúdo digitado ou de arquivo. */
export function resumoDaChamada(ferramenta: string, input: Record<string, unknown>): string {
  if (DIGITAM.test(ferramenta)) {
    const alvo = typeof input.caminho === 'string' ? `${curto(input.caminho, 90)} · ` : ''
    const escrito = [input.texto, input.text, input.value, input.valor, input.conteudo, input.novo].find((v) => typeof v === 'string')
    return `${alvo}${typeof escrito === 'string' ? `${escrito.length} caracteres` : 'texto'}`
  }
  for (const campo of CAMPOS) {
    const valor = input[campo]
    if (typeof valor === 'string' && valor.trim()) return curto(valor)
  }
  const chaves = Object.keys(input)
  return chaves.length ? curto(chaves.join(', ')) : ''
}

export class RegistroDeChamadas {
  private readonly abertas = new Map<string, { chamada: Omit<ChamadaRegistrada, 'resultado' | 'ms'>; inicio: number }>()
  private readonly ultimas: ChamadaRegistrada[] = []
  private fila: Promise<void> = Promise.resolve()

  /** `arquivo` devolve onde gravar, ou null para ficar só na memória (testes). */
  constructor(
    private readonly arquivo: () => string | null,
    private readonly agora: () => number = Date.now
  ) {}

  private base(sessao: string, ferramenta: string, input: Record<string, unknown>): Omit<ChamadaRegistrada, 'resultado' | 'ms'> {
    const nome = ferramenta.startsWith(PREFIXO_REMOTO) ? ferramenta.slice(PREFIXO_REMOTO.length) : ferramenta
    return { hora: new Date(this.agora()).toISOString(), sessao: sessao.slice(0, 8), ferramenta: nome, resumo: resumoDaChamada(nome, input) }
  }

  /** A chamada foi liberada e vai rodar: fica aberta até o resultado chegar. */
  abrir(id: string, sessao: string, ferramenta: string, input: Record<string, unknown>): void {
    if (!id) return
    if (this.abertas.size >= ABERTAS_MAXIMO) this.abertas.delete(this.abertas.keys().next().value as string)
    this.abertas.set(id, { chamada: this.base(sessao, ferramenta, input), inicio: this.agora() })
  }

  /** O resultado da chamada chegou. Id desconhecido (não era do remoto) não faz nada. */
  fechar(id: string, erro: boolean): void {
    const aberta = this.abertas.get(id)
    if (!aberta) return
    this.abertas.delete(id)
    this.gravar({ ...aberta.chamada, resultado: erro ? 'erro' : 'ok', ms: Math.max(0, this.agora() - aberta.inicio) })
  }

  /** A chamada foi negada (recurso desligado ou o técnico não aprovou): não rodou. */
  negar(sessao: string, ferramenta: string, input: Record<string, unknown>, id?: string): void {
    if (id) this.abertas.delete(id)
    this.gravar({ ...this.base(sessao, ferramenta, input), resultado: 'negada' })
  }

  recentes(quantas = 20): ChamadaRegistrada[] {
    return this.ultimas.slice(-quantas)
  }

  /** Espera o que estava para ser gravado (testes e fechamento do app). */
  pronto(): Promise<void> {
    return this.fila
  }

  private gravar(chamada: ChamadaRegistrada): void {
    this.ultimas.push(chamada)
    if (this.ultimas.length > NA_MEMORIA) this.ultimas.shift()
    const destino = this.arquivo()
    if (!destino) return
    this.fila = this.fila
      .then(async () => {
        await mkdir(dirname(destino), { recursive: true })
        const tamanho = await stat(destino).then((s) => s.size, () => 0)
        if (tamanho > TAMANHO_MAXIMO) await rename(destino, `${destino}.1`).catch(() => undefined)
        await appendFile(destino, `${JSON.stringify(chamada)}\n`, 'utf8')
      })
      .catch(() => undefined) // registro é melhor esforço: nunca derruba a chamada
  }
}
