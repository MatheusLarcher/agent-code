import { app } from 'electron'
import { join } from 'node:path'
import { APP_VARIANT_ENV, variantFromPackageName } from './appVariant'
import { devDataDir } from './devDataDir'

/**
 * Importado PRIMEIRO pelo index.ts: na instância isolada de desenvolvimento
 * (`AGENT_CODE_DEV_DATA_DIR`), o `userData` muda antes de qualquer módulo lê-lo
 * no carregamento (o pareamento do celular lê já na avaliação do index.ts) e
 * antes do lock de instância única, que passa a ser o desta pasta.
 *
 * A variante (original ou Homol) também se decide aqui, pelo nome do pacote, e
 * SEMPRE sobrescreve a variável herdada: uma Homol que abre um processo da
 * original não a transforma em Homol. O userData da Homol já vem separado pelo
 * próprio nome (%APPDATA%\agent-code-homol).
 */
process.env[APP_VARIANT_ENV] = variantFromPackageName(app.getName())

const dev = devDataDir()
if (dev) app.setPath('userData', join(dev, 'userData'))
