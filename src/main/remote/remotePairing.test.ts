// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemotePairingStore, validPushToken } from './remotePairing'

const TOKEN = 'fcm-token-do-celular-0123456789abcdef:APA91b'

describe('RemotePairingStore — token do push', () => {
  it('guarda o token do celular pareado, sobrevive a reabrir e some ao trocar de celular', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-code-pairing-'))
    try {
      const store = new RemotePairingStore(dir)
      expect(store.setPushToken(TOKEN)).toBe(false) // sem celular pareado
      store.setPairedDevice({ id: 'cel-1', name: 'Galaxy', pairedAt: 1 })
      expect(store.setPushToken(TOKEN)).toBe(true)
      store.setPairedDevice({ id: 'cel-1', name: 'Galaxy', pairedAt: 2 }) // o mesmo celular de novo: fica
      expect(new RemotePairingStore(dir).pushToken()).toBe(TOKEN)
      store.setPairedDevice({ id: 'cel-2', name: 'Outro', pairedAt: 3 })
      expect(store.pushToken()).toBeNull()
      store.setPushToken(TOKEN)
      store.setPairedDevice(null) // despareou
      expect(store.pushToken()).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('validPushToken recusa o que não tem cara de token FCM', () => {
    expect(validPushToken(TOKEN)).toBe(TOKEN)
    for (const lixo of ['', 'curto', 'com espaço no meio do token aqui', '<script>alert(1)</script>xxxxxxx', 42, null]) {
      expect(validPushToken(lixo)).toBeNull()
    }
  })
})
