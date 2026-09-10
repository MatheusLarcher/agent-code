import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecretVault, SecretVaultError } from './secretVault'
import type { SecureStorageAdapter } from '../persistence/bootstrapStore'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync), writeFileSync: vi.fn(actual.writeFileSync) }
})

/** Chave de teste: o cofre agora grava a chave no mesmo envelope. */
const TEST_KEY = Buffer.alloc(32, 7).toString('base64')
const keyMaterial = (): string => TEST_KEY

const VALUE = 'isolated-test-credential-12345'
function fakeCrypto(): SecureStorageAdapter {
  return {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.concat([
      Buffer.from('TEST:'), Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0xa5))
    ])),
    decryptString: vi.fn((value: Buffer) => {
      if (value.subarray(0, 5).toString() !== 'TEST:') throw new Error(`bad crypto ${VALUE}`)
      return Buffer.from([...value.subarray(5)].map((byte) => byte ^ 0xa5)).toString()
    })
  }
}

describe('SecretVault (isolated encrypted device file)', () => {
  let root: string
  let directory: string
  let file: string
  let enabled: boolean
  let crypto: SecureStorageAdapter
  let audit: ReturnType<typeof vi.fn<(event: { action: 'get' | 'put' | 'delete'; name: string }) => void>>
  let vault: SecretVault
  beforeEach(async () => {
    vi.clearAllMocks()
    root = await mkdtemp(join(tmpdir(), 'agent-code-vault-test-'))
    directory = join(root, 'vault')
    file = join(directory, 'secret-vault.json')
    enabled = true
    crypto = fakeCrypto()
    audit = vi.fn()
    vault = new SecretVault({ directory, enabled: () => enabled, secureStorage: crypto, audit , keyMaterial })
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('roundtrips plaintext intentionally; files and metadata never contain values', async () => {
    const metadata = await vault.put('service.key', VALUE)
    expect(await vault.get('service.key')).toBe(VALUE)
    expect(await vault.listMetadataForManagement()).toEqual([metadata])
    expect(Object.keys(metadata).sort()).toEqual(['createdAt', 'name', 'updatedAt'])
    const text = await readFile(file, 'utf8')
    expect(text).not.toContain(VALUE)
    const ciphertext = JSON.parse(text).records[0].ciphertext
    expect(Buffer.from(ciphertext, 'base64').toString()).not.toContain(VALUE)
    expect(await readdir(directory)).toEqual(['secret-vault.json'])
    const reopened = new SecretVault({ directory, enabled: () => true, secureStorage: crypto , keyMaterial })
    expect(await reopened.get('service.key')).toBe(VALUE)
  })

  it('updates a name without changing creation metadata', async () => {
    const first = await vault.put('key', VALUE)
    const second = await vault.put('key', 'replacement')
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt >= first.updatedAt).toBe(true)
    expect(await vault.get('key')).toBe('replacement')
    expect(await vault.listMetadataForManagement()).toHaveLength(1)
  })

  it('keeps timestamps valid if the wall clock moves backwards', async () => {
    await vault.put('key', VALUE)
    const data = JSON.parse(await readFile(file, 'utf8'))
    data.records[0].createdAt = '2099-01-01T00:00:00.000Z'
    data.records[0].updatedAt = '2099-01-02T00:00:00.000Z'
    await writeFile(file, JSON.stringify(data))
    const updated = await vault.put('key', 'replacement')
    expect(updated.updatedAt).toBe('2099-01-02T00:00:00.000Z')
    expect(await vault.get('key')).toBe('replacement')
  })

  it('accepts the exact plaintext byte limit and Unicode values', async () => {
    const value = 'é'.repeat(32_768)
    await vault.put('boundary', value)
    expect(await vault.get('boundary')).toBe(value)
  })

  it('rechecks after an audit callback before releasing plaintext', async () => {
    await vault.put('key', VALUE)
    audit.mockImplementation(() => { enabled = false })
    await expect(vault.get('key')).rejects.toMatchObject({ code: 'DISABLED' })
  })

  it('rejects invalid decrypted plaintext without returning it', async () => {
    await vault.put('key', VALUE)
    vi.mocked(crypto.decryptString).mockReturnValue('')
    await expect(vault.get('key')).rejects.toMatchObject({ code: 'CRYPTO_FAILED' })
  })

  it('returns null for missing secrets without creating the directory', async () => {
    expect(await vault.get('absent')).toBeNull()
    expect(await vault.listMetadataForManagement()).toEqual([])
    expect(await readdir(root)).toEqual([])
  })

  it('off refuses get and put, preserves data, and permits separate explicit management', async () => {
    await vault.put('key', VALUE)
    const before = await readFile(file, 'utf8')
    enabled = false
    await expect(vault.get('key')).rejects.toMatchObject({ code: 'DISABLED' })
    await expect(vault.put('other', VALUE)).rejects.toMatchObject({ code: 'DISABLED' })
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await vault.listMetadataForManagement()).toHaveLength(1)
    enabled = true
    expect(await vault.get('key')).toBe(VALUE)
    enabled = false
    expect(await vault.deleteForManagement('key')).toBe(true)
    expect(await vault.deleteForManagement('key')).toBe(false)
    expect(await vault.listMetadataForManagement()).toEqual([])
  })

  it('rechecks both queued writes and reads against the live callback', async () => {
    await vault.put('key', VALUE)
    const before = await readFile(file, 'utf8')
    const put = vault.put('other', VALUE)
    const get = vault.get('key')
    enabled = false
    await expect(put).rejects.toMatchObject({ code: 'DISABLED' })
    await expect(get).rejects.toMatchObject({ code: 'DISABLED' })
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('rechecks after encryption changes the toggle', async () => {
    vi.mocked(crypto.encryptString).mockImplementation(() => { enabled = false; return Buffer.from('cipher') })
    await expect(vault.put('key', VALUE)).rejects.toMatchObject({ code: 'DISABLED' })
    expect(await readdir(root)).toEqual([])
  })

  it('rechecks before returning decrypted plaintext', async () => {
    await vault.put('key', VALUE)
    vi.mocked(crypto.decryptString).mockImplementation(() => { enabled = false; return VALUE })
    await expect(vault.get('key')).rejects.toMatchObject({ code: 'DISABLED' })
  })

  it('rechecks before commit after temporary file writing', async () => {
    await vault.put('key', VALUE)
    const before = await readFile(file, 'utf8')
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(fs.writeFileSync).mockImplementationOnce((...args) => {
      actual.writeFileSync(...args)
      enabled = false
    })
    await expect(vault.put('key', 'replacement')).rejects.toMatchObject({ code: 'DISABLED' })
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await readdir(directory)).toEqual(['secret-vault.json'])
  })

  it('serializes concurrent writes across instances of the same root', async () => {
    const second = new SecretVault({ directory: join(directory, '.'), enabled: () => true, secureStorage: crypto , keyMaterial })
    await Promise.all(Array.from({ length: 40 }, (_, i) =>
      (i % 2 ? vault : second).put(`key.${i}`, `value-${i}`)))
    expect(await vault.listMetadataForManagement()).toHaveLength(40)
    for (let i = 0; i < 40; i++) expect(await second.get(`key.${i}`)).toBe(`value-${i}`)
  })

  it('serializes writes and explicit deletes without resurrecting a removed record', async () => {
    await vault.put('old', VALUE)
    await Promise.all([vault.put('new', VALUE), vault.deleteForManagement('old'), vault.put('last', VALUE)])
    expect((await vault.listMetadataForManagement()).map((item) => item.name)).toEqual(['new', 'last'])
  })

  it.each(['../escape', '', 'white space', '/absolute', 'a/b', 'a\\b', 'a'.repeat(129), 'a\n'])('rejects invalid name %j', async (name) => {
    await expect(vault.put(name, VALUE)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(vault.get(name)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(vault.deleteForManagement(name)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(await readdir(root)).toEqual([])
  })

  it.each(['', 'x'.repeat(65_537), 'é'.repeat(32_769)])('rejects empty/oversized plaintext (%#)', async (value) => {
    await expect(vault.put('key', value)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(crypto.encryptString).not.toHaveBeenCalled()
  })

  it('requires an absolute directory and an enabled callback', () => {
    expect(() => new SecretVault({ directory: 'relative', enabled: () => true, secureStorage: crypto , keyMaterial }))
      .toThrow(SecretVaultError)
    expect(() => new SecretVault({ directory, secureStorage: crypto } as never)).toThrow(SecretVaultError)
  })

  it('rejects unavailable encryption for reads and writes without plaintext fallback', async () => {
    await vault.put('key', VALUE)
    vi.mocked(crypto.isEncryptionAvailable).mockReturnValue(false)
    await expect(vault.get('key')).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(vault.put('other', VALUE)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(await vault.listMetadataForManagement()).toHaveLength(1)
    expect(await vault.deleteForManagement('key')).toBe(true)
  })

  it('rechecks encryption availability for queued work', async () => {
    const pending = vault.put('key', VALUE)
    vi.mocked(crypto.isEncryptionAvailable).mockReturnValue(false)
    await expect(pending).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(await readdir(root)).toEqual([])
  })

  it('sanitizes encryption and decryption exceptions without causes', async () => {
    await vault.put('key', VALUE)
    vi.mocked(crypto.encryptString).mockImplementation(() => { throw new Error(`${VALUE} ${file}`) })
    vi.mocked(crypto.decryptString).mockImplementation(() => { throw new Error(`${VALUE} ${file}`) })
    for (const operation of [vault.put('other', VALUE), vault.get('key')]) {
      const error = await operation.catch((caught: unknown) => caught) as Error
      expect(error).toMatchObject({ code: 'CRYPTO_FAILED', message: 'Secret vault encryption operation failed.' })
      expect(error.cause).toBeUndefined()
      expect(JSON.stringify(error)).not.toContain(VALUE)
      expect(error.message).not.toContain(file)
    }
  })

  it.each([Buffer.alloc(0), Buffer.alloc(131_073)])('rejects invalid encrypted output (%#)', async (ciphertext) => {
    vi.mocked(crypto.encryptString).mockReturnValue(ciphertext)
    await expect(vault.put('key', VALUE)).rejects.toMatchObject({ code: 'CRYPTO_FAILED' })
    expect(await readdir(root)).toEqual([])
  })

  it.each([
    '{broken', 'null', '{}', '{"version":2,"records":[]}',
    '{"version":1,"records":[],"unexpected":"value"}',
    '{"version":1,"records":[null]}'
  ])('refuses malformed files rather than treating corruption as empty (%#)', async (text) => {
    await mkdir(directory)
    await writeFile(file, text)
    await expect(vault.get('key')).rejects.toMatchObject({ code: 'INVALID_DATA' })
    await expect(vault.put('key', VALUE)).rejects.toMatchObject({ code: 'INVALID_DATA' })
    await expect(vault.deleteForManagement('key')).rejects.toMatchObject({ code: 'INVALID_DATA' })
    expect(await readFile(file, 'utf8')).toBe(text)
  })

  it.each(['name', 'ciphertext', 'createdAt', 'updatedAt', 'duplicate', 'extra'])('validates record envelope: %s', async (field) => {
    await vault.put('key', VALUE)
    const data = JSON.parse(await readFile(file, 'utf8'))
    if (field === 'duplicate') data.records.push(data.records[0])
    else if (field === 'extra') data.records[0].value = VALUE
    else data.records[0][field] = 'invalid!'
    const text = JSON.stringify(data)
    await writeFile(file, text)
    await expect(vault.put('key', VALUE)).rejects.toMatchObject({ code: 'INVALID_DATA' })
    expect(await readFile(file, 'utf8')).toBe(text)
  })

  it('refuses an oversized on-disk file', async () => {
    await mkdir(directory)
    await writeFile(file, ' '.repeat(4 * 1024 * 1024 + 1))
    await expect(vault.get('key')).rejects.toMatchObject({ code: 'INVALID_DATA' })
  })

  it('refuses overwriting structurally valid but undecryptable existing ciphertext', async () => {
    await vault.put('key', VALUE)
    const data = JSON.parse(await readFile(file, 'utf8'))
    data.records[0].ciphertext = Buffer.from('not-valid-encryption').toString('base64')
    const text = JSON.stringify(data)
    await writeFile(file, text)
    await expect(vault.get('key')).rejects.toMatchObject({ code: 'CRYPTO_FAILED' })
    await expect(vault.put('key', 'replacement')).rejects.toMatchObject({ code: 'CRYPTO_FAILED' })
    expect(await readFile(file, 'utf8')).toBe(text)
  })

  it.each(['write', 'rename'])('failed %s preserves old file and cleans temporary ciphertext', async (stage) => {
    await vault.put('key', VALUE)
    const before = await readFile(file, 'utf8')
    const fail = (): never => { throw new Error(`${VALUE} ${file}`) }
    if (stage === 'write') vi.mocked(fs.writeFileSync).mockImplementationOnce(fail)
    else vi.mocked(fs.renameSync).mockImplementationOnce(fail)
    await expect(vault.put('key', 'replacement')).rejects.toMatchObject({
      code: 'IO_FAILED', message: 'Secret vault storage operation failed.'
    })
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(await readdir(directory)).toEqual(['secret-vault.json'])
    await vault.put('after-failure', VALUE)
    expect(await vault.get('after-failure')).toBe(VALUE)
  })

  it('rejects a symbolic directory ancestor (junction on Windows)', async () => {
    const real = join(root, 'real')
    await mkdir(real)
    await symlink(real, directory, process.platform === 'win32' ? 'junction' : 'dir')
    const nested = new SecretVault({ directory: join(directory, 'nested'), enabled: () => true, secureStorage: crypto , keyMaterial })
    await expect(nested.put('key', VALUE)).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
    await expect(nested.get('key')).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
    expect(await readdir(real)).toEqual([])
  })

  it('rejects a target that is a junction/symlink rather than a regular file', async () => {
    await mkdir(directory)
    const target = join(root, 'target')
    await mkdir(target)
    await symlink(target, file, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(vault.put('key', VALUE)).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
    await expect(vault.listMetadataForManagement()).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
  })

  it('rejects hard-linked target files', async () => {
    await vault.put('key', VALUE)
    await link(file, join(root, 'alias'))
    await expect(vault.get('key')).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
    await expect(vault.put('key', 'replacement')).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
  })

  it('rejects regular files in directory paths', async () => {
    await writeFile(directory, 'not a directory')
    await expect(vault.put('key', VALUE)).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
  })

  it('audit contains action/name only and ignores errors without logging', async () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      audit.mockImplementation(() => { throw new Error(VALUE) })
      await vault.put('key', VALUE)
      expect(await vault.get('key')).toBe(VALUE)
      await vault.deleteForManagement('key')
      expect(audit.mock.calls).toEqual([
        [{ action: 'put', name: 'key' }], [{ action: 'get', name: 'key' }], [{ action: 'delete', name: 'key' }]
      ])
      expect(logger).not.toHaveBeenCalled()
    } finally { logger.mockRestore() }
  })

  it('fails closed on enabled and availability callbacks throwing sensitive errors', async () => {
    const broken = new SecretVault({ directory, secureStorage: crypto, enabled: () => { throw new Error(VALUE) } })
    await expect(broken.get('key')).rejects.toMatchObject({ code: 'DISABLED' })
    vi.mocked(crypto.isEncryptionAvailable).mockImplementation(() => { throw new Error(VALUE) })
    await expect(vault.put('key', VALUE)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })
})
