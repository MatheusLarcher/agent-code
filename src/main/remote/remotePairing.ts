// Estado do controle remoto que é DESTE PC, e não do usuário: a identidade da
// instalação perante o broker e o único celular pareado com ele.
//
// Fica num JSON em `userData` (pasta local do Electron), fora da pasta de dados
// sincronizável — dois PCs abrindo a mesma pasta de dados têm o mesmo token de
// config, mas cada um precisa da SUA identidade e do SEU celular. É o que faz um
// segundo PC poder parear um celular novo sem roubar o do primeiro.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RemotePairedDevice } from '../../shared/ipc'

interface PairingFile {
  version: 1
  instanceId: string
  pairedDevice: RemotePairedDevice | null
  /** Token FCM do celular pareado (push com o app fechado); some ao trocar de celular. */
  pushToken?: string | null
}

const PUSH_TOKEN_RE = /^[A-Za-z0-9:_\-.]{20,4096}$/

/** Token FCM válido (o formato que o Firebase devolve) ou null. */
export function validPushToken(raw: unknown): string | null {
  return typeof raw === 'string' && PUSH_TOKEN_RE.test(raw) ? raw : null
}

export class RemotePairingStore {
  private readonly path: string
  private data: PairingFile | null = null

  constructor(userDataDir: string) {
    this.path = join(userDataDir, 'remote-pairing.json')
  }

  /** Identidade estável desta instalação (gerada uma vez, nunca muda). */
  instanceId(): string {
    return this.load().instanceId
  }

  pairedDevice(): RemotePairedDevice | null {
    return this.load().pairedDevice
  }

  setPairedDevice(device: RemotePairedDevice | null): void {
    const cur = this.load()
    // Outro celular (ou nenhum): o token do anterior não vale mais para este PC.
    const same = !!device && cur.pairedDevice?.id === device.id
    this.write({ ...cur, pairedDevice: device, pushToken: same ? cur.pushToken ?? null : null })
  }

  pushToken(): string | null {
    return this.load().pairedDevice ? this.load().pushToken ?? null : null
  }

  /** Grava o token do celular pareado; sem celular pareado, recusa (`false`). */
  setPushToken(token: string | null): boolean {
    const cur = this.load()
    if (!cur.pairedDevice) return false
    this.write({ ...cur, pushToken: token })
    return true
  }

  private load(): PairingFile {
    if (this.data) return this.data
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<PairingFile>
      if (parsed && typeof parsed.instanceId === 'string' && parsed.instanceId) {
        const device = parsed.pairedDevice
        this.data = {
          version: 1,
          instanceId: parsed.instanceId,
          pairedDevice:
            device && typeof device.id === 'string' && device.id
              ? { id: device.id, name: String(device.name || 'celular'), pairedAt: Number(device.pairedAt) || 0 }
              : null,
          pushToken: validPushToken(parsed.pushToken)
        }
        return this.data
      }
    } catch {
      /* ausente ou ilegível → recomeça; o pareamento é refeito com um QR */
    }
    const fresh: PairingFile = { version: 1, instanceId: randomUUID(), pairedDevice: null }
    this.write(fresh)
    return fresh
  }

  private write(next: PairingFile): void {
    this.data = next
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temp = `${this.path}.tmp-${process.pid}`
      writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8')
      renameSync(temp, this.path)
    } catch {
      /* best-effort: em memória continua valendo nesta execução */
    }
  }
}
