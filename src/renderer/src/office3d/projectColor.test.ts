import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Color, Group, Mesh, MeshLambertMaterial } from 'three'
import { reserveProjectColor, SANDBOX_PROJECT_COLOR } from '@shared/projectColor'
import type { OfficeFeed } from '../office/adapter/feed'
import { deriveOfficeModel, principalKey, roomIdFor } from '../office/adapter/model'
import type { OfficeCharacterModel } from '../office/adapter/model'
import { CharacterBody } from './agentBody'
import type { AvatarBody } from './agentAvatar'
import { seedColor } from './appearance'
import type { Character3D } from './characters'
import type { ScreenView } from './decor'
import { demoFeed } from './demoFeed'
import { DEMO_LOOP_MS } from './demoTimeline'
import { snapshotOf } from './events'
import { createKit } from './kit'
import { layoutOffice } from './layout'
import { projectColorHex, shirtHex } from './projectColor'
import type { Rig } from './rig'
import type { RoomLod } from './roomLod'
import { OfficeScene } from './scene'
import { fillScreen, SCREEN_ACCENT } from './screens'
import { createSignTexture, NEUTRAL } from './sign'

const ALPHA = 'C:\\proj\\Alpha'
const colors = (hex: string): { projectColors: OfficeFeed['projectColors'] } => ({ projectColors: { [ALPHA]: { hex, source: 'logo' } } })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a cor do projeto (helper único)', () => {
  it('a do feed vence; pelo cwd ou pelo id da sala, igual', () => {
    const f = colors('#3c9add')
    expect(projectColorHex(f, ALPHA)).toBe('#3c9add')
    expect(projectColorHex(f, roomIdFor(ALPHA))).toBe('#3c9add')
    expect(projectColorHex(f, 'c:/proj/alpha/')).toBe('#3c9add')
  })

  it('sem a cor (detecção em andamento ou falhou), a reserva do PROJETO', () => {
    expect(projectColorHex(null, ALPHA)).toBe(reserveProjectColor(roomIdFor(ALPHA)))
    expect(projectColorHex({ projectColors: {} }, ALPHA)).toBe(reserveProjectColor(roomIdFor(ALPHA)))
    // Cor inválida vinda de fora não pinta.
    expect(projectColorHex({ projectColors: { [ALPHA]: { hex: 'red', source: 'logo' } } }, ALPHA)).toBe(reserveProjectColor(roomIdFor(ALPHA)))
  })

  it('nunca por conversa: todos os personagens do projeto vestem a mesma cor', () => {
    const f = { ...demoFeed(14_916_667 * DEMO_LOOP_MS + 20_000) }
    const model = deriveOfficeModel(f, 14_916_667 * DEMO_LOOP_MS + 20_000)
    const byRoom = new Map<string, Set<string>>()
    for (const c of model.characters) {
      if (!c.roomId) continue
      const set = byRoom.get(c.roomId) ?? new Set()
      set.add(shirtHex(f, c.roomId)!)
      byRoom.set(c.roomId, set)
    }
    expect(byRoom.size).toBeGreaterThan(1)
    for (const set of byRoom.values()) expect(set.size).toBe(1)
  })

  it('o Sandbox é uma cor só; a Central (sem projeto) fica como está', () => {
    expect(projectColorHex(null, 'C:\\x\\sandbox\\2026-10-07_10-00_ab12')).toBe(SANDBOX_PROJECT_COLOR.hex)
    expect(projectColorHex(null, 'sandbox')).toBe(SANDBOX_PROJECT_COLOR.hex)
    expect(shirtHex(colors('#3c9add'), null)).toBeNull()
  })
})

describe('a camisa troca em cena, sem recriar o corpo', () => {
  it('CharacterBody: a cor do boneco e o uniform do avatar mudam; o corpo é o mesmo', () => {
    const shirt = new MeshLambertMaterial({ color: seedColor('conv:a') })
    const body = new CharacterBody(null, {} as Rig, new Group(), 'principal', 'conv:a', 'conv:a', null, shirt)
    const tint = { tintColor: { value: new Color() } }
    const avatar = { material: { userData: { tint } } } as unknown as AvatarBody
    body.avatar = avatar
    expect(body.paintShirt(colors('#3c9add'), ALPHA)).toBe(true)
    expect(shirt.color.equals(new Color('#3c9add'))).toBe(true)
    expect(tint.tintColor.value.equals(new Color('#3c9add'))).toBe(true)
    expect(body.paintShirt(colors('#3c9add'), ALPHA)).toBe(false)
    body.setShirtColor('#dd5fa9')
    expect(body.avatar).toBe(avatar)
    expect(shirt.color.equals(new Color('#dd5fa9'))).toBe(true)
    // Sem projeto (a Central): a cor da seed, como sempre.
    body.setShirtColor(null)
    expect(shirt.color.equals(seedColor('conv:a'))).toBe(true)
  })

  it('na cena: a cor chega depois e quem está em cena troca na hora (mesmo personagem, mesmo material); a Central não muda', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const now = 14_916_667 * DEMO_LOOP_MS + 20_000
    const s = new OfficeScene()
    const sync = (feed: OfficeFeed): void => {
      const model = deriveOfficeModel(feed, now)
      s.sync(layoutOffice(model), feed, { snapshot: snapshotOf(feed, model, now), events: [], wallNow: now, t: 0 })
    }
    const base = demoFeed(now)
    const cwd = 'C:\\demo\\agent-code'
    // Antes da detecção: a reserva do projeto.
    sync({ ...base, projectColors: {} })
    const chars = (s as unknown as { chars: Map<string, Character3D> }).chars
    const v = chars.get(principalKey('demo-0-0'))!
    const mat = v.shirtMat
    expect(mat.color.equals(new Color(reserveProjectColor(roomIdFor(cwd))))).toBe(true)
    const central = chars.get(principalKey('central'))!
    const centralColor = central.shirtMat.color.clone()
    expect(centralColor.equals(seedColor(central.model.seed))).toBe(true)
    // A detecção chegou.
    sync({ ...base, projectColors: { [cwd]: { hex: '#d97757', source: 'marca' } } })
    expect(chars.get(principalKey('demo-0-0'))).toBe(v)
    expect(v.shirtMat).toBe(mat)
    expect(mat.color.equals(new Color('#d97757'))).toBe(true)
    // Todo personagem do projeto (principais, especialistas, subagentes, PO...) veste a mesma.
    for (const c of chars.values()) if (c.model.roomId === roomIdFor(cwd)) expect(c.shirtMat.color.equals(new Color('#d97757'))).toBe(true)
    expect(central.shirtMat.color.equals(centralColor)).toBe(true)
    s.dispose()
  })
})

describe('nada em volta do agente pega a cor do projeto', () => {
  let kit: ReturnType<typeof createKit>
  const owner = { key: 'a', convId: 'c1', role: 'principal', active: false, label: 'a' } as unknown as OfficeCharacterModel
  const screen = (): ScreenView => ({ mesh: new Mesh(), state: 'off', on: null, page: null, accent: '', status: 'idle', lod: { level: 0, culled: false, placed: true } as unknown as RoomLod, zone: 'island0' })

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    kit ??= createKit(1)
  })

  it('a tela das mesas usa o mesmo tom neutro em qualquer projeto (com ou sem cor detectada)', () => {
    const a = screen()
    const b = screen()
    fillScreen(a, kit, owner, roomIdFor(ALPHA), colors('#3c9add') as OfficeFeed, null, false, true)
    fillScreen(b, kit, owner, 'c:/proj/beta', null, null, false, true)
    expect(a.accent).toBe(SCREEN_ACCENT)
    expect(b.accent).toBe(SCREEN_ACCENT)
  })

  it('as placas (chão e mesa) pintam o tom neutro fixo, igual para todo projeto', () => {
    const drawn = (accentId: string, style: 'floor' | 'desk'): string[] => {
      const out: string[] = []
      const ctx = new Proxy({} as Record<string | symbol, unknown>, {
        get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 10 }) : k === 'createLinearGradient' ? () => ({ addColorStop: (_: number, c: string) => out.push(c) }) : () => {}),
        set: (t, k, v) => {
          if (k === 'fillStyle' || k === 'strokeStyle') out.push(String(v))
          t[k] = v
          return true
        }
      })
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
      createSignTexture('proj', null, accentId, 1, () => {}, style).dispose()
      return out.filter((c) => typeof c === 'string' && !c.startsWith('[object'))
    }
    expect(drawn('c:/proj/alpha', 'desk')).toEqual(drawn('c:/proj/beta', 'desk'))
    expect(drawn('c:/proj/alpha', 'desk')).toContain(NEUTRAL.top)
    expect(drawn('c:/proj/alpha', 'floor')).toEqual(drawn('c:/proj/beta', 'floor'))
    expect(drawn('c:/proj/alpha', 'floor')).toContain(NEUTRAL.bar)
  })
})
