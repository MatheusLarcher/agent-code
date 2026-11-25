// Contrato do suporte remoto: o que o exe do cliente, o relay e o Agent Code
// combinam entre si. Duas partes:
//
//  1. PAREAMENTO (nosso, pequeno): o exe disca para o relay por WebSocket em
//     `SUPORTE_CAMINHOS.ws`, mostra um código e espera. O Agent Code chama
//     `POST SUPORTE_CAMINHOS.parear` com a chave da equipe; o relay pergunta ao
//     exe, a janela pergunta ao cliente e, no Permitir, o exe gera o token.
//  2. CHAMADAS (MCP padrão): JSON-RPC por HTTP sem estado em
//     `SUPORTE_CAMINHOS.mcp/<sessão>`, com `Authorization: Bearer <token>`. O
//     relay desce a requisição ao exe pelos mesmos frames `open`/`data`/`end` e
//     sobe a resposta por `head`/`data`/`end` que já servem o celular.
//
// Os mesmos nomes e números existem em `src/suporte/Contrato.cs` (exe) e no topo
// de `broker/src/suporte.js` (relay, publicado sozinho na VPS); o teste
// `suporteRemoto.test.ts` lê os dois como texto e confere com este arquivo.
// Nada de chave, token ou código real aqui: o repositório é público.

/** Versão do protocolo de pareamento. Sobe quando uma mudança quebra exe antigo. */
export const SUPORTE_PROTOCOLO = 1
/** Exe abaixo desta versão recebe `atualize` e mostra o link de download. */
export const SUPORTE_PROTOCOLO_MINIMO = 1

/** Caminhos no relay (o host é `REMOTE_PUBLIC_HOST`, de `src/shared/ipc.ts`). */
export const SUPORTE_CAMINHOS = {
  /** WebSocket em que o exe do cliente disca e fica esperando. */
  ws: '/__suporte',
  /** POST do Agent Code: chave da equipe + código + nome do técnico. */
  parear: '/suporte/parear',
  /** Chamadas MCP: `<mcp>/<sessão>`, token no cabeçalho. */
  mcp: '/suporte/mcp',
  /** Fluxo de eventos de estado da sessão (SSE): `<eventos>/<sessão>`. */
  eventos: '/suporte/eventos',
  /** POST do Agent Code para encerrar a sessão: `<encerrar>/<sessão>`. */
  encerrar: '/suporte/encerrar',
  /** GET sem token: redireciona para o download do exe. */
  download: '/suporte'
} as const

/** Para onde `GET /suporte` redireciona: o exe da release mais recente. */
export const SUPORTE_DOWNLOAD_URL =
  'https://github.com/MatheusLarcher/agent-code/releases/latest/download/AgentCode-Suporte.exe'

/** Cabeçalho em que o Agent Code manda a chave da equipe no `parear`. */
export const SUPORTE_CABECALHO_CHAVE = 'x-suporte-chave'

/** Recursos que o cliente liga e desliga na janela. A ordem é a da janela. */
export const SUPORTE_RECURSOS = ['tela', 'comandos', 'arquivos', 'chrome', 'celular', 'administrador'] as const
export type SuporteRecurso = (typeof SUPORTE_RECURSOS)[number]

/** Nascem ligados no Permitir da sessão. */
export const SUPORTE_RECURSOS_BASICOS = ['tela', 'comandos', 'arquivos'] as const
/** Nascem desligados e travados até o técnico pedir e o cliente permitir. */
export const SUPORTE_RECURSOS_EXTRAS = ['chrome', 'celular', 'administrador'] as const

/** Estado de um recurso do lado do cliente. */
export type SuporteEstadoRecurso =
  /** O cliente permitiu e não desligou: as ferramentas respondem. */
  | 'ligado'
  /** O cliente desligou na janela: "o cliente desligou este recurso". */
  | 'desligado'
  /** Extra ainda não pedido: "peça ao cliente com remoto_pedir_recurso". */
  | 'travado'

/** Prefixo de toda ferramenta que o exe declara. */
export const SUPORTE_PREFIXO_FERRAMENTA = 'remoto_'

/** Limites combinados entre as três pontas. Bytes e milissegundos. */
export const SUPORTE_LIMITES = {
  /** Corpo máximo de uma chamada (requisição ou resposta). */
  chamadaBytes: 32 * 1024 * 1024,
  /** Arquivo máximo por transferência (enviar ou baixar). */
  arquivoBytes: 20 * 1024 * 1024,
  /** Saída de comando por leitura; acima disso vão começo e fim, com aviso do corte. */
  saidaBytes: 200 * 1024,
  /** Tempo de um comando quando a chamada não informa. */
  comandoPadraoMs: 120_000,
  /** Maior tempo que uma chamada pode pedir. */
  comandoMaximoMs: 600_000,
  /** Intervalo do batimento (`ping`) do exe. */
  batimentoMs: 20_000,
  /** Sem nenhum sinal por este tempo = conexão morta. */
  mortoMs: 65_000,
  /** Exe conectado sem técnico por este tempo é desconectado. */
  semTecnicoMs: 15 * 60_000,
  /** Pedido de acesso sem resposta do cliente = recusado. */
  pedidoAcessoMs: 60_000,
  /** Pedido de recurso extra sem resposta do cliente = não permitido. */
  pedidoRecursoMs: 5 * 60_000,
  /** Dígitos do código que o cliente lê para o técnico. */
  codigoDigitos: 9,
  /** Tentativas erradas (código ou chave) por minuto, por endereço. */
  tentativasPorMinuto: 5,
  /** Bloqueio do endereço que estourou as tentativas. */
  bloqueioMs: 10 * 60_000,
  /** Exes conectados ao mesmo tempo no relay. */
  maximoExes: 50
} as const
export type SuporteLimite = keyof typeof SUPORTE_LIMITES

// ---- Pareamento: mensagens no WebSocket do exe ---------------------------

/** O que o exe conta de si. `capacidades` é o que este exe sabe fazer (um exe
 *  de outro sistema declara uma lista menor); não assume Windows. */
export interface SuporteInfoExe {
  /** Nome do computador do cliente. */
  pc: string
  /** `windows` hoje; o contrato não assume. */
  sistema: string
  /** Versão do sistema, texto livre. */
  versaoSistema: string
  /** Versão do exe. */
  versao: string
  capacidades: SuporteRecurso[]
  /** O exe está rodando como administrador. */
  admin: boolean
}

/** exe → relay, primeira mensagem. Com `retomar`, o exe (reaberto elevado)
 *  reassume a sessão que já existia em vez de anunciar um código novo. */
export interface SuporteHello extends SuporteInfoExe {
  type: 'hello'
  v: number
  /** `SUPORTE_LIMITES.codigoDigitos` dígitos, gerado na hora. Ausente ao retomar. */
  codigo?: string
  retomar?: { sessao: string; segredo: string }
}

/** relay → exe: resposta ao `hello`. */
export type SuporteRespostaHello =
  | { type: 'ready'; sessao?: string }
  /** Exe antigo demais: mostrar o link de download. */
  | { type: 'atualize'; url: string }
  | { type: 'negado'; motivo: SuporteMotivoNegado }

export type SuporteMotivoNegado =
  /** O relay está sem a chave da equipe: canal desligado. */
  | 'desligado'
  /** Código já em uso por outro exe: gerar outro e tentar de novo. */
  | 'codigo'
  /** Limite de exes conectados. */
  | 'cheio'
  /** `hello` malformado ou retomada inválida. */
  | 'invalido'
  /** Ficou `semTecnicoMs` sem técnico. */
  | 'ocioso'

/** relay → exe: um técnico informou o código; a janela pergunta ao cliente. */
export interface SuportePedido {
  type: 'pedido'
  id: string
  tecnico: string
}

/** relay → exe: o técnico desistiu antes da resposta; fechar a pergunta. */
export interface SuportePedidoCancelado {
  type: 'cancelado'
  id: string
}

/** exe → relay: resposta do cliente. Só `ok: true` traz o token, e ele vai
 *  apenas na resposta daquele `parear`. */
export interface SuporteAceite {
  type: 'aceite'
  id: string
  ok: boolean
  token?: string
}

/** relay → exe, depois do aceite: a sessão e o segredo com que o exe a retoma
 *  ao ser reaberto como administrador. O segredo não sai do exe. */
export interface SuporteRetomar {
  type: 'retomar'
  sessao: string
  segredo: string
}

/** exe → relay: algo mudou do lado do cliente; o relay repassa aos eventos. */
export interface SuporteAviso {
  type: 'evento'
  evento: 'recurso' | 'admin'
  recurso?: SuporteRecurso
  estado?: SuporteEstadoRecurso
}

/** Qualquer lado encerra: o cliente (Encerrar/fechar a janela) ou o técnico. */
export interface SuporteEncerrar {
  type: 'encerrar'
  motivo?: 'cliente' | 'tecnico'
}

// ---- Lado do Agent Code: HTTP no relay -----------------------------------

/** Corpo de `POST /suporte/parear` (a chave vai em `SUPORTE_CABECALHO_CHAVE`). */
export interface SuportePedidoParear {
  codigo: string
  tecnico: string
}

/** Resposta 200 do `parear`. */
export interface SuporteSessaoPareada {
  sessao: string
  token: string
  info: SuporteInfoExe
}

/** Corpo `{ erro }` das respostas que não são 200. */
export type SuporteErroParear =
  /** 403: chave da equipe errada. */
  | 'chave'
  /** 404: nenhum exe com esse código. */
  | 'codigo'
  /** 403: o cliente recusou ou não respondeu em `pedidoAcessoMs`. */
  | 'recusado'
  /** 409: já existe técnico (ou pedido em aberto) nesse código. */
  | 'ocupado'
  /** 429: endereço bloqueado por tentativas erradas. */
  | 'bloqueado'
  /** 503: relay sem a chave da equipe. */
  | 'desligado'
  /** 400: corpo malformado. */
  | 'invalido'

/** Um evento do fluxo `GET /suporte/eventos/<sessão>` (linha `data:` do SSE). */
export interface SuporteEvento {
  evento: 'conectado' | 'recurso' | 'admin' | 'caiu' | 'encerrado'
  /** Só no `conectado`: o exe já está como administrador. */
  admin?: boolean
  recurso?: SuporteRecurso
  estado?: SuporteEstadoRecurso
  motivo?: 'cliente' | 'tecnico'
}

/** Código como o cliente lê: três grupos de três (`482 917 305`). */
export function formatarCodigoSuporte(codigo: string): string {
  const digitos = normalizarCodigoSuporte(codigo)
  return digitos.replace(/(\d{3})(?=\d)/g, '$1 ')
}

/** Tira espaço, ponto e hífen de um código digitado ou ditado. */
export function normalizarCodigoSuporte(codigo: string): string {
  return (codigo || '').replace(/[\s.\-]/g, '')
}

/** O texto é um código válido (só dígitos, no tamanho combinado)? */
export function codigoSuporteValido(codigo: string): boolean {
  return new RegExp(`^\\d{${SUPORTE_LIMITES.codigoDigitos}}$`).test(normalizarCodigoSuporte(codigo))
}

export function ehRecursoSuporte(valor: unknown): valor is SuporteRecurso {
  return typeof valor === 'string' && (SUPORTE_RECURSOS as readonly string[]).includes(valor)
}

// ---- Lado do Agent Code: sessão na tela e ajustes --------------------------

/** Link que o técnico manda ao cliente (o relay redireciona para o download). */
export const SUPORTE_LINK_CLIENTE = 'https://agent-code.larchertech.com/suporte'

/** Servidor MCP do exe do cliente, ligado só na conversa que conectou. */
export const SUPORTE_SERVIDOR_REMOTO = 'remoto'
/** Servidor MCP interno (conectar, status, desconectar), só com o recurso ativado. */
export const SUPORTE_SERVIDOR_INTERNO = 'suporte'

/** Estado da sessão de suporte no Agent Code do técnico. Uma por vez no app. */
export type SuporteEstadoSessao =
  | 'desligado'
  /** O pedido de pareamento saiu e o relay ainda não respondeu. */
  | 'conectando'
  /** O relay achou o cliente: a janela dele está perguntando. */
  | 'aguardando'
  | 'conectado'
  /** A conexão com o PC do cliente caiu sem ninguém encerrar. */
  | 'caiu'

/** Por que a última sessão ou tentativa acabou. `n` sobe a cada aviso (um toast por aviso). */
export interface SuporteAvisoSessao {
  n: number
  tipo: 'recusado' | 'caiu' | 'encerrado' | 'erro'
  texto: string
}

/** O que a tela vê da sessão. Nunca traz o token nem a chave da equipe. */
export interface SuporteStatus {
  estado: SuporteEstadoSessao
  /** Conversa dona da sessão (ou da tentativa em curso). */
  convId: string | null
  pc?: string
  sistema?: string
  admin?: boolean
  recursos?: Partial<Record<SuporteRecurso, SuporteEstadoRecurso>>
  aviso?: SuporteAvisoSessao
}

/** Ajustes de Configurações > Suporte Remoto. A chave nunca volta à tela: só `temChave`. */
export interface SuporteAjustes {
  ativado: boolean
  tecnico: string
  temChave: boolean
}

/** O que a tela manda ao salvar. `chave: ''` apaga a chave (e desliga o recurso). */
export interface SuporteAjustesPatch {
  ativado?: boolean
  tecnico?: string
  chave?: string
}

/** Tamanhos aceitos nos ajustes. */
export const SUPORTE_AJUSTES_LIMITES = { tecnicoMax: 40, chaveMin: 20, chaveMax: 200 } as const

/** A chave da equipe tem formato aceitável? (Quem confere o valor é o relay.) */
export function chaveSuporteValida(chave: string): boolean {
  return (
    chave.length >= SUPORTE_AJUSTES_LIMITES.chaveMin &&
    chave.length <= SUPORTE_AJUSTES_LIMITES.chaveMax &&
    /^[\x21-\x7e]+$/.test(chave)
  )
}
