// O serviço de suporte remoto do app: um só, criado no primeiro uso. Sem `electron` aqui:
// agentSession importa este arquivo, e o caminho do registro vem de fora (index.ts do main).
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { SuporteAjustes } from '../../shared/suporteRemoto'
import { loadConfig } from '../config'
import { RegistroDeChamadas } from './registro'
import { SuporteRemotoServico } from './servico'
import { createSuporteMcpServer } from './servidor'
import { ligarSuporteNaConversa, type LigacaoDeps, type LigacaoSuporte } from './sessaoMcp'

let arquivoDoRegistro: string | null = null
let servico: SuporteRemotoServico | null = null

/** Onde o registro das chamadas é gravado (o main define no boot; null = só memória). */
export function definirArquivoDoRegistro(caminho: string | null): void {
  arquivoDoRegistro = caminho
}

/** O interruptor de Configurações, lido ao vivo. */
export function suporteAtivado(): boolean {
  return loadConfig().suporteRemotoEnabled === true
}

/** O que a tela pode ver dos ajustes: a chave nunca sai daqui, só se existe. */
export function ajustesDoSuporte(): SuporteAjustes {
  const config = loadConfig()
  return {
    ativado: config.suporteRemotoEnabled === true,
    tecnico: config.suporteRemotoTecnico ?? '',
    temChave: Boolean(config.suporteRemotoChave)
  }
}

export function suporteRemoto(): SuporteRemotoServico {
  return (servico ??= new SuporteRemotoServico({
    ajustes: () => {
      const config = loadConfig()
      return {
        ativado: config.suporteRemotoEnabled === true,
        tecnico: config.suporteRemotoTecnico ?? '',
        chave: config.suporteRemotoChave ?? ''
      }
    },
    registro: new RegistroDeChamadas(() => arquivoDoRegistro)
  }))
}

/** Servidor interno `suporte` (conectar, status, desconectar) preso a uma conversa. */
export function servidorSuporteDaConversa(convId: string): McpServerConfig {
  return createSuporteMcpServer(suporteRemoto(), convId)
}

/** A sessão do agente de uma conversa se liga ao suporte (ver sessaoMcp.ts). */
export function ligarSessaoDoAgente(deps: Pick<LigacaoDeps, 'convId' | 'base' | 'consulta' | 'aoFalhar'>): LigacaoSuporte {
  return ligarSuporteNaConversa({
    ...deps,
    servico: suporteRemoto(),
    ativado: suporteAtivado,
    servidorSuporte: () => servidorSuporteDaConversa(deps.convId)
  })
}
