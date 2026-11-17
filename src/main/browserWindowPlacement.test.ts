import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VISIBLE_WINDOW_ARGS, wasParkedOffscreen, windowPlacementArgs } from './browserWindowPlacement'

const dirs: string[] = []
function profile(prefs?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'ac-placement-'))
  dirs.push(dir)
  if (prefs !== undefined) {
    mkdirSync(join(dir, 'Default'))
    writeFileSync(join(dir, 'Default', 'Preferences'), typeof prefs === 'string' ? prefs : JSON.stringify(prefs))
  }
  return dir
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('posição da janela do Chrome do agente', () => {
  it('perfil que ficou em -32000 volta para um lugar visível', () => {
    const dir = profile({ browser: { window_placement: { left: -32000, top: -32000, right: -30704, bottom: -31066 } } })
    expect(wasParkedOffscreen(dir)).toBe(true)
    expect(windowPlacementArgs(dir)).toEqual([...VISIBLE_WINDOW_ARGS])
  })

  it('janela num segundo monitor à esquerda fica onde o usuário deixou', () => {
    const dir = profile({ browser: { window_placement: { left: -1800, top: 40, right: -500, bottom: 900 } } })
    expect(wasParkedOffscreen(dir)).toBe(false)
    expect(windowPlacementArgs(dir)).toEqual([])
  })

  it('perfil novo, sem posição salva ou ilegível não força posição', () => {
    expect(windowPlacementArgs(profile())).toEqual([])
    expect(windowPlacementArgs(profile({ browser: {} }))).toEqual([])
    expect(windowPlacementArgs(profile('{quebrado'))).toEqual([])
  })
})
