import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { createChromeMcpServer } from '../chromeBridge/tools'
import { chromeBridge, chromeTabMemory } from '../chromeBridge/state'
import { loadConfig } from '../config'
import { createWindowsControlMcpServer } from '../windowsControl/tools'
import { windowsControl } from '../windowsControl/service'

/**
 * As ferramentas do app que a rodada do monitor ganha além das embutidas do SDK:
 * o Chrome do usuário e o controle do Windows, SÓ com os interruptores das
 * Configurações ligados (na rodada não há o gate da sessão — é bypass). O
 * `encerrar` cancela o escopo do controle do Windows quando a rodada acaba.
 */
export function ferramentasDaRodada(convId: string): { servidores: Record<string, McpServerConfig>; encerrar(): void } {
  const cfg = loadConfig()
  const servidores: Record<string, McpServerConfig> = {}
  let encerrar = (): void => undefined
  if (cfg.chromeControlEnabled === true) servidores.chrome = createChromeMcpServer(chromeBridge, chromeTabMemory(convId))
  if (process.platform === 'win32' && cfg.windowsControlEnabled === true) {
    const scope = windowsControl.createScope()
    servidores.windows = createWindowsControlMcpServer(scope)
    encerrar = () => scope.cancel()
  }
  return { servidores, encerrar }
}
