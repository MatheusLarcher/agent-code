/**
 * Variante do app: a original ("main") ou a "Agent Code Homol", instalada lado a
 * lado (electron-builder.homol.yml). A Homol tem pastas de dados, portas e
 * extensão do Chrome próprias para nunca ler nem escrever nas da original.
 *
 * Puro, sem electron: roda também no worker de skills. Quem decide é
 * devDataDirBoot.ts (primeiro import do main), que grava a variante em
 * AGENT_CODE_APP_VARIANT a partir do nome do pacote — o worker e os processos
 * filhos herdam. Sem a variável (testes, scripts), é a original.
 */
export type AppVariant = 'main' | 'homol'

export const APP_VARIANT_ENV = 'AGENT_CODE_APP_VARIANT'
/** `name` do package.json da Homol (extraMetadata do electron-builder.homol.yml). */
export const HOMOL_PACKAGE_NAME = 'agent-code-homol'

export function appVariant(env: NodeJS.ProcessEnv = process.env): AppVariant {
  return env[APP_VARIANT_ENV] === 'homol' ? 'homol' : 'main'
}

export const isHomol = (env: NodeJS.ProcessEnv = process.env): boolean => appVariant(env) === 'homol'

/** Variante pelo nome do pacote (app.getName()); qualquer outro nome é a original. */
export function variantFromPackageName(name: string): AppVariant {
  return name === HOMOL_PACKAGE_NAME ? 'homol' : 'main'
}

interface VariantProfile {
  appUserModelId: string
  /** Pasta em %LOCALAPPDATA% / Application Support e em Documentos. */
  dirName: string
  /** Pasta na home do usuário (ponteiro do cache, chaves do APK, Android). */
  homeDirName: string
  postgresPort: number
  remotePort: number
  chromeBridgePorts: readonly number[]
  mcpInboundPortStart: number
}

const PROFILES: Record<AppVariant, VariantProfile> = {
  main: {
    appUserModelId: 'com.larchertech.agentcode',
    dirName: 'agent-code',
    homeDirName: '.agent-code',
    postgresPort: 45432,
    remotePort: 8765,
    chromeBridgePorts: [47831, 47832, 47833, 47834, 47835],
    mcpInboundPortStart: 47110
  },
  homol: {
    appUserModelId: 'com.larchertech.agentcode.homol',
    dirName: 'agent-code-homol',
    homeDirName: '.agent-code-homol',
    postgresPort: 45442,
    remotePort: 8785,
    chromeBridgePorts: [47841, 47842, 47843, 47844, 47845],
    mcpInboundPortStart: 47150
  }
}

export function variantProfile(env: NodeJS.ProcessEnv = process.env): VariantProfile {
  return PROFILES[appVariant(env)]
}

/**
 * Chave pública da extensão do Chrome da Homol (SPKI DER em base64). Gravada no
 * manifest.json copiado para a pasta da Homol: id próprio, então o Chrome a vê
 * como outra extensão, ao lado da original.
 */
export const HOMOL_CHROME_EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlDJgbyIJD/ZpbBbxZfpSLpH1PUhgPUVJgegpFeJYri4kpluK0osUgSXdaPJB2DY/iALwzhv5/VENA5VUd2IweNHkgoqXuDmmOdVFUTx4c89rCssR2bkyf4e9rFFMTuzhIbcmllO/ICeOQOFFEDz8W5V9aopUXjiqRwHX4Nl7M9rUzuWfnYIpKpX0uS+6Rml+GPI2HHxwWJiDfuSK0ODe8LzPTY/JnYevwuFjOjEi3fgDxuEtIWIDef3EYYCS+mmarbXKGovBZGEqWElOn7JFQiWIobn02AiRYKovI9zMMIxK2xrnxGl88MmXzDjcjeldr90VxtczEN2Hu2/oNqV4uwIDAQAB'
/** Id derivado da chave acima (extensionIdFromKey; conferido no teste). */
export const HOMOL_CHROME_EXTENSION_ID = 'oagjkobmjcjkbkndhjnbojpgpbfjmbgh'
