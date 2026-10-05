import { CubeUVReflectionMapping, HalfFloatType } from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentModels, avatarPreview, ENV_FILE, parseEnv, setAvatarPreview, SWAPS_PER_FRAME } from './agentModels'
import { meanP95 } from './quality'

function envBytes(w: number, h: number, extra = 0): Uint8Array {
  const b = new Uint8Array(12 + w * h * 8 + extra)
  b.set([80, 77, 82, 77]) // "PMRM"
  const v = new DataView(b.buffer)
  v.setUint32(4, w, true)
  v.setUint32(8, h, true)
  return b
}

afterEach(() => setAvatarPreview(false))

describe('ambiente assado do PBR (ambiente.bin)', () => {
  it('vira uma textura CubeUV HalfFloat, pronta para o material (sem PMREM no app)', () => {
    const t = parseEnv(envBytes(336, 256))!
    expect(t.image.width).toBe(336)
    expect(t.image.height).toBe(256)
    expect(t.type).toBe(HalfFloatType)
    expect(t.mapping).toBe(CubeUVReflectionMapping)
    expect(t.generateMipmaps).toBe(false)
  })

  it('formato errado (assinatura, tamanho) não vira textura', () => {
    expect(parseEnv(new Uint8Array(4))).toBeNull()
    expect(parseEnv(envBytes(4, 4, 8))).toBeNull()
    const wrong = envBytes(4, 4)
    wrong[0] = 0
    expect(parseEnv(wrong)).toBeNull()
  })
})

describe('chave de teste e carga dos modelos', () => {
  it('desligada, ninguém usa o modelo (o app fica como está) e nada é pedido ao main', () => {
    const fetch = vi.fn(async () => null)
    const m = new AgentModels(null, () => {}, null, fetch)
    expect(avatarPreview()).toBe(false)
    expect(m.modelFor('principal')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('ligada, pede o v1 uma vez; arquivo ausente vira aviso e o boneco fica', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetch = vi.fn(async () => null)
    const changed = vi.fn()
    const m = new AgentModels(null, changed, null, fetch)
    setAvatarPreview(true)
    expect(changed).toHaveBeenCalledTimes(1)
    const v = m.version
    expect(m.modelFor('executor')).toBeNull()
    expect(m.modelFor('principal')).toBeNull()
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('principal.glb')
    // Falhou uma vez: não tenta de novo a cada quadro.
    expect(m.modelFor('principal')).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(m.version).toBe(v)
    expect(ENV_FILE).toBe('ambiente.bin')
    m.dispose()
    warn.mockRestore()
  })

  it('troca de corpo limitada por quadro: o resto pede outro quadro', async () => {
    const changed = vi.fn()
    const m = new AgentModels(null, changed, null, async () => null)
    const got = Array.from({ length: SWAPS_PER_FRAME + 4 }, () => m.claim())
    expect(got.filter(Boolean)).toHaveLength(SWAPS_PER_FRAME)
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    m.dispose()
  })
})

describe('tempo de quadro do HUD (média e P95)', () => {
  it('média e percentil 95 das amostras da janela', () => {
    const buf = new Float32Array(100)
    for (let i = 0; i < 100; i++) buf[i] = i + 1
    const [mean, p95] = meanP95(buf, 100)
    expect(mean).toBeCloseTo(50.5)
    expect(p95).toBe(96)
    expect(meanP95(buf, 0)).toEqual([0, 0])
  })
})
