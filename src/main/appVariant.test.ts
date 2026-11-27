// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  APP_VARIANT_ENV,
  HOMOL_CHROME_EXTENSION_ID,
  HOMOL_CHROME_EXTENSION_KEY,
  appVariant,
  isHomol,
  variantFromPackageName,
  variantProfile
} from './appVariant'
import { CHROME_EXTENSION_ID, extensionIdFromKey } from './chromeBridge/extensionId'

const HOMOL = { [APP_VARIANT_ENV]: 'homol' }

describe('variante do app', () => {
  it('sem a variável (ou com valor estranho) é a original', () => {
    expect(appVariant({})).toBe('main')
    expect(appVariant({ [APP_VARIANT_ENV]: 'qualquer' })).toBe('main')
    expect(isHomol({})).toBe(false)
    expect(isHomol(HOMOL)).toBe(true)
  })

  it('decide pelo nome do pacote', () => {
    expect(variantFromPackageName('agent-code-homol')).toBe('homol')
    expect(variantFromPackageName('agent-code-desktop')).toBe('main')
    expect(variantFromPackageName('')).toBe('main')
  })

  it('a original mantém exatamente as pastas e portas de hoje', () => {
    expect(variantProfile({})).toEqual({
      appUserModelId: 'com.larchertech.agentcode',
      dirName: 'agent-code',
      homeDirName: '.agent-code',
      postgresPort: 45432,
      remotePort: 8765,
      chromeBridgePorts: [47831, 47832, 47833, 47834, 47835],
      mcpInboundPortStart: 47110
    })
  })

  it('a Homol não divide pasta nem porta com a original', () => {
    const main = variantProfile({})
    const homol = variantProfile(HOMOL)
    expect(homol.appUserModelId).not.toBe(main.appUserModelId)
    expect(homol.dirName).not.toBe(main.dirName)
    expect(homol.homeDirName).not.toBe(main.homeDirName)
    // Postgres e celular têm fallback de +N portas: a distância cobre as tentativas.
    expect(Math.abs(homol.postgresPort - main.postgresPort)).toBeGreaterThanOrEqual(10)
    expect(Math.abs(homol.remotePort - main.remotePort)).toBeGreaterThanOrEqual(20)
    expect(homol.chromeBridgePorts.some((p) => main.chromeBridgePorts.includes(p))).toBe(false)
    // A faixa do MCP de entrada tem 40 portas: as duas faixas não se cruzam.
    expect(homol.mcpInboundPortStart - main.mcpInboundPortStart).toBeGreaterThanOrEqual(40)
  })

  it('a key da extensão da Homol gera o id gravado e difere da original', () => {
    expect(extensionIdFromKey(HOMOL_CHROME_EXTENSION_KEY)).toBe(HOMOL_CHROME_EXTENSION_ID)
    expect(HOMOL_CHROME_EXTENSION_ID).not.toBe(CHROME_EXTENSION_ID)
  })
})
