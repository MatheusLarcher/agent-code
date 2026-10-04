// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ enabled: false, get: vi.fn(async () => 'old'), list: vi.fn(async () => [{ name: 'vault' }]) }))
vi.mock('../config', () => ({ loadConfig: () => ({ secretVaultEnabled: state.enabled }) }))
vi.mock('../store', () => ({ getCacheInfo: () => ({}) }))
vi.mock('../memory/vaultKey', () => ({ createVaultCipher: () => ({}) }))
vi.mock('../memory/secretVault', () => ({ VAULT_FILENAME: 'vault', SecretVault: class { get = state.get; listMetadataForManagement = state.list } }))
import { configureSecretVault, readSecret, readSecretForReveal } from '../memory/memoryRuntime'
import { buildSecretsHintWithMask } from './secretsHint'
afterEach(() => { configureSecretVault(null); state.enabled = false })
it('olho lê senha atual mesmo com envio ao modelo desligado, sem memorizar valor', async () => {
  configureSecretVault({ directory: '/test-vault' })
  expect(await readSecret('vault')).toBeNull()
  state.get.mockResolvedValueOnce('old').mockResolvedValueOnce('new')
  expect(await readSecretForReveal('vault')).toBe('old')
  expect(await readSecretForReveal('vault')).toBe('new')
  expect(await readSecretForReveal(' ')).toBeNull()
})
it('hint cru para SDK e lista para máscara vêm da mesma leitura', async () => {
  configureSecretVault({ directory: '/test-vault' }); state.enabled = true
  state.get.mockResolvedValue('password')
  const hint = await buildSecretsHintWithMask()
  expect(hint.text).toContain('vault: password')
  expect(hint.masked).toContain('vault: ⟦senha:vault⟧')
  expect(hint.secrets).toEqual([{ name: 'vault', value: 'password' }])
})
