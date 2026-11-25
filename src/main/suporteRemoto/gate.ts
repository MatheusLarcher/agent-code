// Gate de permissão do suporte remoto, avaliado ANTES do "Permitir tudo" (como o do
// Windows e o do Chrome). A lista do que é só leitura é FIXA aqui: o que o exe do cliente
// declara sobre as próprias ferramentas não decide nada — ferramenta que esta lista não
// conhece é tratada como escrita, mesmo que venha anotada como "só leitura".
import { SUPORTE_SERVIDOR_INTERNO, SUPORTE_SERVIDOR_REMOTO } from '../../shared/suporteRemoto'
import { destructiveCommandReason, destructiveTextReason } from '../tasks/destructiveCommand'
import { SUPORTE_DESLIGADO } from './servico'

const REMOTO = `mcp__${SUPORTE_SERVIDOR_REMOTO}__`
const SUPORTE = `mcp__${SUPORTE_SERVIDOR_INTERNO}__`

/** Ferramentas do exe que só olham o PC do cliente: liberadas sem perguntar. */
export const REMOTO_READ_TOOLS: ReadonlySet<string> = new Set(
  [
    'remoto_info',
    'remoto_list_windows',
    'remoto_list_apps',
    'remoto_get_state',
    'remoto_form_fields',
    'remoto_captura_tela',
    'remoto_processo_ler',
    'remoto_arquivo_ler',
    'remoto_arquivo_buscar',
    'remoto_arquivo_procurar',
    'remoto_chrome_status',
    'remoto_chrome_list_tabs',
    'remoto_chrome_snapshot',
    'remoto_chrome_screenshot',
    'remoto_chrome_scroll',
    'remoto_chrome_wait',
    'remoto_android_dispositivos',
    'remoto_android_captura'
  ].map((nome) => `${REMOTO}${nome}`)
)

/** Do servidor interno: consultar e encerrar não mexem em nada do cliente. */
const SUPORTE_LIVRES: ReadonlySet<string> = new Set([`${SUPORTE}suporte_status`, `${SUPORTE}suporte_desconectar`])

/** Ferramentas que levam um comando: (nome, campo do comando, shell para o detector). */
const COM_COMANDO: ReadonlyArray<[string, string, 'PowerShell' | 'Bash']> = [
  [`${REMOTO}remoto_executar`, 'comando', 'PowerShell'],
  [`${REMOTO}remoto_android_shell`, 'comando', 'Bash']
]

/**
 * O que derruba ou estraga o PC de um cliente e a lista geral do Bash não cobre (ela pensa
 * no projeto do próprio usuário): desligar, formatar, apagar em massa, mexer em disco,
 * conta, registro, serviço e rede — a rede cai e a sessão de suporte cai junto.
 */
const NO_PC_DO_CLIENTE: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:shutdown|logoff)(?:\.exe)?\b|\b(?:restart|stop)-computer\b/iu, 'desligar, reiniciar ou sair da sessão do computador do cliente'],
  [/\b(?:format(?:\.com)?\s+[a-z]:|format-volume|clear-disk|initialize-disk|remove-partition|diskpart|cipher\s+\/w)/iu, 'formatar ou apagar disco'],
  [/\b(?:del|erase)\b[^|&;\n]*\s\/[sq]\b|\brd\b[^|&;\n]*\s\/s\b|\bremove-item\b[^|;\n]*-recurse\b/iu, 'apagar arquivos em massa'],
  [/\breg(?:\.exe)?\s+delete\b|\bremove-item(?:property)?\b[^|;\n]*\b(?:hklm|hkcu|registry)::?/iu, 'apagar chaves do registro'],
  [/\bnet(?:\.exe)?\s+user\b[^|&;\n]*\s\/(?:delete|add)\b|\b(?:remove|new|disable)-localuser\b|\bnet(?:\.exe)?\s+localgroup\b[^|&;\n]*\s\/(?:add|delete)\b/iu, 'criar, remover ou mudar contas do Windows'],
  [/\b(?:disable-netadapter|netsh\s+interface\s+set\s+interface\b[^|&;\n]*\bdisable|ipconfig\s+\/release)\b/iu, 'derrubar a rede do cliente (a sessão cai junto)'],
  [/\b(?:bcdedit|sfc\s+\/|dism\b[^|&;\n]*\/(?:remove|disable))|\bsc(?:\.exe)?\s+delete\b|\bset-service\b[^|;\n]*-startuptype\s+disabled\b/iu, 'mudar inicialização ou serviços do sistema'],
  [/\bstop-process\b[^|;\n]*-force\b|\btaskkill\b[^|&;\n]*\s\/f\b/iu, 'forçar o fim de um programa do cliente'],
  [/\bpm\s+(?:uninstall|clear)\b|\b(?:wipe|recovery\s+--wipe)|\breboot\b|\brm\s+-[a-z]*r/iu, 'apagar dados ou reiniciar o celular do cliente']
]

/** Motivo para o comando ser destrutivo no PC (ou celular) do cliente, ou null. */
export function motivoDestrutivoRemoto(toolName: string, input: Record<string, unknown>): string | null {
  const alvo = COM_COMANDO.find(([nome]) => nome === toolName)
  if (!alvo) return null
  const comando = typeof input[alvo[1]] === 'string' ? (input[alvo[1]] as string) : ''
  if (!comando.trim()) return null
  for (const [padrao, motivo] of NO_PC_DO_CLIENTE) if (padrao.test(comando)) return motivo
  return destructiveCommandReason(alvo[2], { command: comando }) ?? destructiveTextReason(comando)
}

export type RemotoGate =
  /** Recurso desligado em Configurações: nega sempre; "Permitir tudo" não atravessa. */
  | { decisao: 'negar'; mensagem: string }
  /** Só leitura, da lista fixa: roda sem perguntar. */
  | { decisao: 'liberar' }
  /** Destrutivo: vai ao técnico mesmo com "Permitir tudo". */
  | { decisao: 'perguntar'; motivo: string }
  /** Não é do suporte, ou é escrita comum: segue o fluxo normal de aprovação. */
  | null

/**
 * O mesmo gate para o PreToolUse: um `allow` do settings.json pula o canUseTool, não o hook.
 * `deny` barra ali mesmo; `ask` força a passagem pelo canUseTool, que leva ao técnico.
 */
export function remotoPreToolDecision(
  toolName: string,
  input: Record<string, unknown>,
  ativado: unknown
): { decision: 'deny' | 'ask'; reason: string } | null {
  const gate = remotoGateDecision(toolName, input, ativado)
  if (gate?.decisao === 'negar') return { decision: 'deny', reason: gate.mensagem }
  if (gate?.decisao === 'perguntar') return { decision: 'ask', reason: `No computador do cliente (${gate.motivo}): precisa da confirmação do usuário.` }
  return null
}

export function remotoGateDecision(toolName: string, input: Record<string, unknown>, ativado: unknown): RemotoGate {
  const doRemoto = toolName.startsWith(REMOTO)
  if (!doRemoto && !toolName.startsWith(SUPORTE)) return null
  if (ativado !== true) return { decisao: 'negar', mensagem: SUPORTE_DESLIGADO }
  if (!doRemoto) return SUPORTE_LIVRES.has(toolName) ? { decisao: 'liberar' } : null
  if (REMOTO_READ_TOOLS.has(toolName)) return { decisao: 'liberar' }
  const motivo = motivoDestrutivoRemoto(toolName, input)
  return motivo ? { decisao: 'perguntar', motivo } : null
}
