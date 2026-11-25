// Cliente HTTP do relay do suporte remoto (broker/src/suporte.js): parear, ouvir os
// eventos da sessão e encerrar. As chamadas MCP não passam por aqui: quem as faz é o
// CLI, pelo servidor `remoto` (ver sessaoMcp.ts). Nada aqui grava token ou chave em log.
import { REMOTE_PUBLIC_HOST } from '../../shared/ipc'
import {
  SUPORTE_CABECALHO_CHAVE,
  SUPORTE_CAMINHOS,
  SUPORTE_LIMITES,
  SUPORTE_RECURSOS,
  ehRecursoSuporte,
  type SuporteErroParear,
  type SuporteEvento,
  type SuporteInfoExe,
  type SuporteSessaoPareada
} from '../../shared/suporteRemoto'

/** A mesma variável de teste do exe: só vale apontando para a própria máquina. */
export const VARIAVEL_RELAY_TESTE = 'AGENT_CODE_SUPORTE_RELAY'

const SESSAO_RE = /^[A-Za-z0-9_-]{16,64}$/
const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/
const ERROS: ReadonlySet<string> = new Set(['chave', 'codigo', 'recusado', 'ocupado', 'bloqueado', 'desligado', 'invalido'])
const EVENTOS: ReadonlySet<string> = new Set(['conectado', 'recurso', 'admin', 'caiu', 'encerrado'])
const ESTADOS: ReadonlySet<string> = new Set(['ligado', 'desligado', 'travado'])

/** Endereço do relay: fixo. A variável de teste é ignorada fora de 127.0.0.1/localhost. */
export function baseDoRelay(env: NodeJS.ProcessEnv = process.env): string {
  const teste = env[VARIAVEL_RELAY_TESTE]
  if (teste) {
    try {
      const url = new URL(teste.replace(/^ws/i, 'http'))
      const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
      if (local && (url.protocol === 'http:' || url.protocol === 'https:')) return url.origin
    } catch {
      /* valor torto: vale o fixo */
    }
  }
  return REMOTE_PUBLIC_HOST
}

/** Endereço das chamadas MCP de uma sessão. */
export function urlMcp(base: string, sessao: string): string {
  return `${base}${SUPORTE_CAMINHOS.mcp}/${sessao}`
}

export type FalhaParear = SuporteErroParear | 'rede' | 'resposta'
export type ResultadoParear =
  | { ok: true; sessao: SuporteSessaoPareada }
  | { ok: false; erro: FalhaParear; esperaSeg?: number }

export interface OpcoesRelay {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

const texto = (valor: unknown, max: number): string => (typeof valor === 'string' ? valor.slice(0, max) : '')

function validarInfo(valor: unknown): SuporteInfoExe {
  const v = (valor && typeof valor === 'object' ? valor : {}) as Record<string, unknown>
  return {
    pc: texto(v.pc, 64) || 'PC',
    sistema: texto(v.sistema, 32) || 'desconhecido',
    versaoSistema: texto(v.versaoSistema, 64),
    versao: texto(v.versao, 32),
    capacidades: Array.isArray(v.capacidades) ? SUPORTE_RECURSOS.filter((r) => (v.capacidades as unknown[]).includes(r)) : [],
    admin: v.admin === true
  }
}

async function lerJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const corpo: unknown = JSON.parse((await res.text()).slice(0, 64 * 1024))
    return corpo && typeof corpo === 'object' ? (corpo as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** `POST /suporte/parear`. Fica pendurado enquanto o cliente decide na janela dele. */
export async function parear(
  base: string,
  dados: { chave: string; codigo: string; tecnico: string },
  opcoes: OpcoesRelay = {}
): Promise<ResultadoParear> {
  const limite = AbortSignal.timeout(SUPORTE_LIMITES.pedidoAcessoMs + 30_000)
  let res: Response
  try {
    res = await (opcoes.fetchImpl ?? fetch)(`${base}${SUPORTE_CAMINHOS.parear}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SUPORTE_CABECALHO_CHAVE]: dados.chave },
      body: JSON.stringify({ codigo: dados.codigo, tecnico: dados.tecnico }),
      signal: opcoes.signal ? AbortSignal.any([opcoes.signal, limite]) : limite
    })
  } catch {
    return { ok: false, erro: 'rede' }
  }
  const corpo = await lerJson(res)
  if (res.status === 200) {
    const sessao = texto(corpo?.sessao, 64)
    const token = texto(corpo?.token, 256)
    if (!SESSAO_RE.test(sessao) || !TOKEN_RE.test(token)) return { ok: false, erro: 'resposta' }
    return { ok: true, sessao: { sessao, token, info: validarInfo(corpo?.info) } }
  }
  const erro = typeof corpo?.erro === 'string' && ERROS.has(corpo.erro) ? (corpo.erro as SuporteErroParear) : 'resposta'
  const espera = Number(corpo?.esperaSeg)
  return { ok: false, erro, ...(Number.isFinite(espera) && espera > 0 ? { esperaSeg: Math.min(espera, 3600) } : {}) }
}

/** `POST /suporte/encerrar/<sessão>`. Melhor esforço: a sessão local acaba de qualquer jeito. */
export async function encerrar(base: string, sessao: string, token: string, opcoes: OpcoesRelay = {}): Promise<void> {
  try {
    await (opcoes.fetchImpl ?? fetch)(`${base}${SUPORTE_CAMINHOS.encerrar}/${sessao}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000)
    })
  } catch {
    /* sem rede: o relay derruba a sessão sozinho quando o exe sair */
  }
}

function validarEvento(valor: unknown): SuporteEvento | null {
  if (!valor || typeof valor !== 'object') return null
  const v = valor as Record<string, unknown>
  if (typeof v.evento !== 'string' || !EVENTOS.has(v.evento)) return null
  const evento: SuporteEvento = { evento: v.evento as SuporteEvento['evento'] }
  if (v.admin === true) evento.admin = true
  if (ehRecursoSuporte(v.recurso) && typeof v.estado === 'string' && ESTADOS.has(v.estado)) {
    evento.recurso = v.recurso
    evento.estado = v.estado as SuporteEvento['estado']
  }
  if (v.motivo === 'cliente' || v.motivo === 'tecnico') evento.motivo = v.motivo
  return evento
}

/**
 * `GET /suporte/eventos/<sessão>` (SSE). Chama `aoEvento` a cada evento e `aoFim` UMA vez
 * quando o fluxo acaba sozinho (rede, relay fora, silêncio maior que `mortoMs`). Devolve a
 * função que para de ouvir sem chamar `aoFim`.
 */
export function ouvirEventos(
  base: string,
  sessao: string,
  token: string,
  aoEvento: (evento: SuporteEvento) => void,
  aoFim: () => void,
  opcoes: OpcoesRelay & { mortoMs?: number } = {}
): () => void {
  const controle = new AbortController()
  const mortoMs = opcoes.mortoMs ?? SUPORTE_LIMITES.mortoMs
  let parado = false
  let vigia: ReturnType<typeof setTimeout> | undefined
  const acabar = (): void => {
    if (parado) return
    parado = true
    clearTimeout(vigia)
    controle.abort()
    aoFim()
  }
  const sinalDeVida = (): void => {
    clearTimeout(vigia)
    vigia = setTimeout(acabar, mortoMs)
    vigia.unref?.()
  }
  void (async () => {
    try {
      sinalDeVida()
      const res = await (opcoes.fetchImpl ?? fetch)(`${base}${SUPORTE_CAMINHOS.eventos}/${sessao}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
        signal: controle.signal
      })
      if (res.status !== 200 || !res.body) return acabar()
      const leitor = res.body.getReader()
      const decodificador = new TextDecoder()
      let resto = ''
      for (;;) {
        const { done, value } = await leitor.read()
        if (done) break
        sinalDeVida()
        resto += decodificador.decode(value, { stream: true })
        if (resto.length > 256 * 1024) break // um evento cabe em poucos bytes: isso é lixo
        let corte: number
        while ((corte = resto.indexOf('\n\n')) >= 0) {
          const bloco = resto.slice(0, corte)
          resto = resto.slice(corte + 2)
          for (const linha of bloco.split('\n')) {
            if (!linha.startsWith('data:')) continue
            let evento: SuporteEvento | null = null
            try {
              evento = validarEvento(JSON.parse(linha.slice(5)))
            } catch {
              /* linha torta: ignora */
            }
            if (evento && !parado) aoEvento(evento)
          }
        }
      }
      acabar()
    } catch {
      acabar()
    }
  })()
  return () => {
    parado = true
    clearTimeout(vigia)
    controle.abort()
  }
}
