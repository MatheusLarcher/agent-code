import { CubeUVReflectionMapping, HalfFloatType } from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentModels, avatarsOff, CENTRAL_MODEL, ENV_FILE, parseEnv, PRINCIPAL_MODEL, ROLE_MODELS, setAvatarsOff, SWAPS_PER_FRAME } from './agentModels'
import { meanP95 } from './quality'

function envBytes(w: number, h: number, extra = 0): Uint8Array {
  const b = new Uint8Array(12 + w * h * 8 + extra)
  b.set([80, 77, 82, 77]) // "PMRM"
  const v = new DataView(b.buffer)
  v.setUint32(4, w, true)
  v.setUint32(8, h, true)
  return b
}

afterEach(() => setAvatarsOff(false))

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

describe('o elenco: modelo pelo papel, a chave do boneco e a carga', () => {
  it('cada papel pede o seu GLB (uma vez); o principal é o v1; papel desconhecido usa o v1', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetch = vi.fn(async () => null)
    const m = new AgentModels(null, () => {}, null, fetch)
    expect(avatarsOff()).toBe(false)
    for (const role of Object.keys(ROLE_MODELS)) expect(m.modelFor(role)).toBeNull()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(Object.keys(ROLE_MODELS).length))
    for (const name of Object.values(ROLE_MODELS)) expect(fetch).toHaveBeenCalledWith(`${name}.glb`)
    expect(ROLE_MODELS.principal).toBe(PRINCIPAL_MODEL)
    // Falhou uma vez: não pede de novo a cada quadro.
    const calls = fetch.mock.calls.length
    expect(m.modelFor('desconhecido')).toBeNull()
    expect(m.modelFor('vigia')).toBeNull()
    expect(fetch.mock.calls.length).toBe(calls)
    expect(ENV_FILE).toBe('ambiente.bin')
    m.dispose()
    warn.mockRestore()
  })

  it('o arquivo de um papel que falha: avisa, sobe a versão (quem esperava troca) e o papel cai no v1', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetch = vi.fn(async () => null)
    const changed = vi.fn()
    const m = new AgentModels(null, changed, null, fetch)
    const v = m.version
    expect(m.modelFor('critico')).toBeNull()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(m.version).toBeGreaterThan(v)
    expect(changed).toHaveBeenCalled()
    // Agora o crítico pede o v1 (o reserva).
    m.modelFor('critico')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith('principal.glb'))
    m.dispose()
    warn.mockRestore()
  })

  it('a chave do boneco (DEV) põe todos de boneco, a Central também, sem pedir nada ao main; desligada, volta o elenco', () => {
    const fetch = vi.fn(async () => null)
    const changed = vi.fn()
    const m = new AgentModels(null, changed, null, fetch)
    setAvatarsOff(true)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(m.modelFor('principal')).toBeNull()
    expect(m.modelFor('principal', CENTRAL_MODEL)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    // O harness do app empacotado liga os avatares pelo motor.
    expect(m.setPreview(true)).toBe(true)
    expect(avatarsOff()).toBe(false)
    m.dispose()
  })

  it('a Central tem modelo próprio (o avatar do usuário): pede o central.glb', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetch = vi.fn(async () => null)
    const m = new AgentModels(null, () => {}, null, fetch)
    expect(m.modelFor('principal', CENTRAL_MODEL)).toBeNull()
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    expect(fetch).toHaveBeenCalledWith('central.glb')
    expect(fetch).toHaveBeenCalledTimes(1)
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
