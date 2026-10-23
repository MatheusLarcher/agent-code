import { DEFAULT_AUTO_MODE_CLASSIFIER_MODEL, type AutoModeClassifierModel } from '../shared/ipc'
import { isConfigLoaded, loadConfig } from './config'

/**
 * O modelo do classificador do modo auto vai para o CLI por esta variável. Só
 * importa nas sessões com `permissionMode: 'auto'` — nas outras o classificador
 * não roda. O CLI oficial recusa Sonnet 5.5/Opus 5.5/Opus 5 nela e deixa a flag
 * remota da conta vencer; quem libera é o claude.exe recompilado que o
 * scripts/build-installer.bat põe no lugar do oficial.
 */
export const AUTO_MODE_MODEL_ENV = 'CLAUDE_CODE_AUTO_MODE_MODEL'

/** O env da sessão 'auto' com o modelo escolhido. 'auto' tira a variável: o CLI decide. */
export function autoModeClassifierEnv(base: NodeJS.ProcessEnv, model: AutoModeClassifierModel): NodeJS.ProcessEnv {
  const env = { ...base }
  if (model === 'auto') delete env[AUTO_MODE_MODEL_ENV]
  else env[AUTO_MODE_MODEL_ENV] = model
  return env
}

/** A escolha das Configurações. Antes de a config carregar (ou nos testes), o padrão. */
export function configuredAutoModeClassifierModel(): AutoModeClassifierModel {
  return isConfigLoaded() ? loadConfig().autoModeClassifierModel : DEFAULT_AUTO_MODE_CLASSIFIER_MODEL
}
