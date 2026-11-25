// A sessão de suporte remoto do lado do técnico: UMA por vez no app, presa à conversa que
// conectou. Pareia no relay, ouve os eventos, entrega a config do servidor MCP `remoto` só
// à conversa dona e avisa a tela a cada mudança. O token vive só nesta memória: não vai a
// log, registro, configuração, status da tela nem mensagem do chat.
import type { McpHttpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import {
  SUPORTE_LIMITES,
  codigoSuporteValido,
  normalizarCodigoSuporte,
  type SuporteAvisoSessao,
  type SuporteEstadoRecurso,
  type SuporteEstadoSessao,
  type SuporteEvento,
  type SuporteInfoExe,
  type SuporteRecurso,
  type SuporteStatus
} from '../../shared/suporteRemoto'
import { PREFIXO_REMOTO, RegistroDeChamadas, type ChamadaRegistrada } from './registro'
import { baseDoRelay, encerrar, ouvirEventos, parear, urlMcp, type FalhaParear } from './relay'

export const SUPORTE_DESLIGADO = 'Suporte remoto desativado. Ative “Suporte Remoto” nas Configurações.'

export interface SuporteServicoDeps {
  /** Lidos na hora de cada uso: o interruptor e a chave valem ao vivo. */
  ajustes: () => { ativado: boolean; tecnico: string; chave: string }
  base?: () => string
  fetchImpl?: typeof fetch
  registro?: RegistroDeChamadas
  /** Quanto esperar a resposta do relay antes de mostrar "aguardando o cliente". */
  aguardandoAposMs?: number
  mortoMs?: number
}

interface SessaoViva {
  id: string
  token: string
  info: SuporteInfoExe
  recursos: Partial<Record<SuporteRecurso, SuporteEstadoRecurso>>
  parar: () => void
}

export type ResultadoConectar = { ok: true; info: SuporteInfoExe } | { ok: false; mensagem: string }

function mensagemDaFalha(erro: FalhaParear, esperaSeg?: number): string {
  switch (erro) {
    case 'chave':
      return 'A chave da equipe não foi aceita. Confira a chave em Configurações > Suporte Remoto.'
    case 'codigo':
      return 'Nenhum cliente com esse código. Confira os 9 dígitos com o cliente: o código muda cada vez que ele abre o programa.'
    case 'recusado':
      return 'O cliente não permitiu o acesso (ou não respondeu em 1 minuto).'
    case 'ocupado':
      return 'Já existe um técnico conectado ou um pedido em aberto nesse código.'
    case 'bloqueado':
      return `Muitas tentativas erradas. Tente de novo em ${Math.max(1, Math.ceil((esperaSeg ?? 600) / 60))} min.`
    case 'desligado':
      return 'O suporte remoto está desligado no servidor.'
    case 'invalido':
      return 'O código ou o seu nome não foram aceitos. Confira os dois.'
    case 'rede':
      return 'Não foi possível falar com o servidor do suporte. Confira a internet e tente de novo.'
    default:
      return 'O servidor do suporte respondeu algo inesperado. Tente de novo.'
  }
}

export class SuporteRemotoServico {
  private estado: SuporteEstadoSessao = 'desligado'
  private convId: string | null = null
  private viva: SessaoViva | null = null
  private aviso: SuporteAvisoSessao | undefined
  private avisos = 0
  private tentativa: AbortController | null = null
  private readonly ouvintes = new Set<(status: SuporteStatus) => void>()
  /** Conversa → como a sessão dela religa ou tira os servidores MCP (sessaoMcp.ts). */
  private readonly conversas = new Map<string, () => Promise<void>>()
  readonly registro: RegistroDeChamadas

  constructor(private readonly deps: SuporteServicoDeps) {
    this.registro = deps.registro ?? new RegistroDeChamadas(() => null)
  }

  private base(): string {
    return (this.deps.base ?? baseDoRelay)()
  }

  status(): SuporteStatus {
    const viva = this.viva
    return {
      estado: this.estado,
      convId: this.convId,
      ...(viva ? { pc: viva.info.pc, sistema: `${viva.info.sistema} ${viva.info.versaoSistema}`.trim(), admin: viva.info.admin, recursos: { ...viva.recursos } } : {}),
      ...(this.aviso ? { aviso: this.aviso } : {})
    }
  }

  onChange(ouvinte: (status: SuporteStatus) => void): () => void {
    this.ouvintes.add(ouvinte)
    return () => this.ouvintes.delete(ouvinte)
  }

  private avisar(): void {
    const status = this.status()
    for (const ouvinte of this.ouvintes) {
      try {
        ouvinte(status)
      } catch {
        /* tela fechada */
      }
    }
  }

  private mudar(estado: SuporteEstadoSessao, convId: string | null, aviso?: Omit<SuporteAvisoSessao, 'n'>): void {
    this.estado = estado
    this.convId = convId
    if (aviso) this.aviso = { n: ++this.avisos, ...aviso }
    else if (estado !== 'desligado' && estado !== 'caiu') this.aviso = undefined
    this.avisar()
  }

  /** A sessão do agente daquela conversa se apresenta; devolve como sair. */
  registrarConversa(convId: string, aplicar: () => Promise<void>): () => void {
    this.conversas.set(convId, aplicar)
    return () => {
      if (this.conversas.get(convId) === aplicar) this.conversas.delete(convId)
    }
  }

  private async aplicarNa(convId: string | null): Promise<void> {
    if (!convId) return
    try {
      await this.conversas.get(convId)?.()
    } catch {
      /* a sessão do agente pode ter morrido no meio: ela reaplica ao subir */
    }
  }

  /** O interruptor de Configurações mudou: toda conversa aberta ganha ou perde o servidor `suporte`. */
  async ajustesMudaram(): Promise<void> {
    if (!this.deps.ajustes().ativado && this.estado !== 'desligado') await this.desconectar()
    await Promise.all([...this.conversas.values()].map((aplicar) => aplicar().catch(() => undefined)))
  }

  /** Config do servidor MCP `remoto`: só para a conversa dona e só com a sessão de pé. */
  mcpDaConversa(convId: string): McpHttpServerConfig | null {
    const viva = this.viva
    if (!viva || this.estado !== 'conectado' || this.convId !== convId) return null
    return {
      type: 'http',
      url: urlMcp(this.base(), viva.id),
      headers: { Authorization: `Bearer ${viva.token}` },
      timeout: SUPORTE_LIMITES.comandoMaximoMs
    }
  }

  /** Id da sessão de pé naquela conversa (para o registro), ou null. */
  sessaoDaConversa(convId: string): string | null {
    return this.viva && this.estado === 'conectado' && this.convId === convId ? this.viva.id : null
  }

  async conectar(convId: string, codigoBruto: string): Promise<ResultadoConectar> {
    const ajustes = this.deps.ajustes()
    if (!ajustes.ativado) return { ok: false, mensagem: SUPORTE_DESLIGADO }
    if (!ajustes.chave) return { ok: false, mensagem: 'Falta a chave da equipe em Configurações > Suporte Remoto.' }
    const tecnico = ajustes.tecnico.trim()
    if (!tecnico) return { ok: false, mensagem: 'Falta o seu nome em Configurações > Suporte Remoto.' }
    if (this.estado === 'conectando' || this.estado === 'aguardando' || this.estado === 'conectado') {
      const aqui = this.convId === convId
      return {
        ok: false,
        mensagem: aqui
          ? 'Já existe uma sessão de suporte aberta nesta conversa. Encerre antes de conectar em outro cliente.'
          : 'Já existe uma sessão de suporte aberta em outra conversa. Só uma por vez: encerre aquela primeiro.'
      }
    }
    const codigo = normalizarCodigoSuporte(String(codigoBruto ?? ''))
    if (!codigoSuporteValido(codigo)) {
      return { ok: false, mensagem: `O código tem ${SUPORTE_LIMITES.codigoDigitos} dígitos. Peça ao cliente para ler de novo.` }
    }

    const tentativa = new AbortController()
    this.tentativa = tentativa
    this.mudar('conectando', convId)
    // Erro de chave ou de código volta na hora; se demorou, é a janela do cliente perguntando.
    const aguardando = setTimeout(() => {
      if (this.tentativa === tentativa && this.estado === 'conectando') this.mudar('aguardando', convId)
    }, this.deps.aguardandoAposMs ?? 1500)
    const resultado = await parear(this.base(), { chave: ajustes.chave, codigo, tecnico }, { fetchImpl: this.deps.fetchImpl, signal: tentativa.signal })
    clearTimeout(aguardando)
    if (this.tentativa !== tentativa) {
      // O técnico desistiu no meio (desconectar): se o relay chegou a parear, fecha lá.
      if (resultado.ok) void encerrar(this.base(), resultado.sessao.sessao, resultado.sessao.token, { fetchImpl: this.deps.fetchImpl })
      return { ok: false, mensagem: 'A conexão foi cancelada.' }
    }
    this.tentativa = null
    if (!resultado.ok) {
      const mensagem = mensagemDaFalha(resultado.erro, resultado.esperaSeg)
      this.mudar('desligado', null, { tipo: resultado.erro === 'recusado' ? 'recusado' : 'erro', texto: mensagem })
      return { ok: false, mensagem }
    }

    const { sessao, token, info } = resultado.sessao
    const recursos: SessaoViva['recursos'] = {}
    const viva: SessaoViva = { id: sessao, token, info: { ...info }, recursos, parar: () => undefined }
    this.viva = viva
    viva.parar = ouvirEventos(
      this.base(),
      sessao,
      token,
      (evento) => this.aoEvento(viva, evento),
      () => void this.acabar(viva, 'caiu', { tipo: 'caiu', texto: 'A conexão com o computador do cliente caiu.' }),
      { fetchImpl: this.deps.fetchImpl, mortoMs: this.deps.mortoMs }
    )
    this.mudar('conectado', convId)
    await this.aplicarNa(convId)
    return { ok: true, info }
  }

  private aoEvento(viva: SessaoViva, evento: SuporteEvento): void {
    if (this.viva !== viva) return
    if (evento.evento === 'conectado') {
      if (evento.admin) viva.info.admin = true
    } else if (evento.evento === 'admin') {
      viva.info.admin = true
    } else if (evento.evento === 'recurso' && evento.recurso && evento.estado) {
      viva.recursos[evento.recurso] = evento.estado
    } else if (evento.evento === 'encerrado') {
      const peloCliente = evento.motivo !== 'tecnico'
      void this.acabar(viva, 'desligado', peloCliente ? { tipo: 'encerrado', texto: 'O cliente encerrou a sessão de suporte.' } : undefined)
      return
    } else if (evento.evento === 'caiu') {
      void this.acabar(viva, 'caiu', { tipo: 'caiu', texto: 'A conexão com o computador do cliente caiu.' })
      return
    }
    this.avisar()
  }

  /** Fim da sessão: o token some da memória e a conversa dona perde o servidor `remoto`. */
  private async acabar(viva: SessaoViva, estado: 'desligado' | 'caiu', aviso?: Omit<SuporteAvisoSessao, 'n'>): Promise<void> {
    if (this.viva !== viva) return
    viva.parar()
    this.viva = null
    const conversa = this.convId
    // Quando cai, a faixa continua na conversa dona para o técnico ver e reconectar.
    this.mudar(estado, estado === 'caiu' ? conversa : null, aviso)
    await this.aplicarNa(conversa)
  }

  /** O técnico encerra (ou desiste do pedido em aberto). Devolve se havia o que encerrar. */
  async desconectar(): Promise<boolean> {
    if (this.tentativa) {
      this.tentativa.abort()
      this.tentativa = null
      this.mudar('desligado', null)
      return true
    }
    const viva = this.viva
    if (!viva) {
      if (this.estado === 'desligado') return false
      this.aviso = undefined
      this.mudar('desligado', null)
      return true
    }
    const { id, token } = viva
    await this.acabar(viva, 'desligado')
    await encerrar(this.base(), id, token, { fetchImpl: this.deps.fetchImpl })
    return true
  }

  // ---- registro local das chamadas (agentSession chama nos dois pontos) -------------

  /** A chamada ao `remoto` vai rodar (abre no PreToolUse) ou foi negada (gate ou técnico). */
  registrarDecisao(convId: string, ferramenta: string, input: Record<string, unknown>, toolUseId: string | undefined, liberada: boolean): void {
    if (!ferramenta.startsWith(PREFIXO_REMOTO)) return
    const sessao = this.sessaoDaConversa(convId) ?? ''
    if (!liberada) this.registro.negar(sessao, ferramenta, input, toolUseId)
    else if (toolUseId) this.registro.abrir(toolUseId, sessao, ferramenta, input)
  }

  /** O resultado de uma ferramenta chegou; só fecha o que foi aberto acima. */
  registrarResultado(toolUseId: string, erro: boolean): void {
    if (toolUseId) this.registro.fechar(toolUseId, erro)
  }

  chamadasRecentes(quantas = 10): ChamadaRegistrada[] {
    return this.registro.recentes(quantas)
  }
}
