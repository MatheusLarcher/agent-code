import { app } from 'electron'
import { join } from 'node:path'
import { devDataDir } from './devDataDir'

/**
 * Importado PRIMEIRO pelo index.ts: na instância isolada de desenvolvimento
 * (`AGENT_CODE_DEV_DATA_DIR`), o `userData` muda antes de qualquer módulo lê-lo
 * no carregamento (o pareamento do celular lê já na avaliação do index.ts) e
 * antes do lock de instância única, que passa a ser o desta pasta.
 */
const dev = devDataDir()
if (dev) app.setPath('userData', join(dev, 'userData'))
