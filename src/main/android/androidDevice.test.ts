// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DEFAULT_AVD } from './androidEnv'
import { emulatorArgs } from './androidDevice'

describe('emulador Android em janela normal', () => {
  it('abre com janela (sem -no-window), na GPU real e com 4 GB', () => {
    const args = emulatorArgs()
    expect(args).not.toContain('-no-window')
    expect(args.slice(0, 2)).toEqual(['-avd', DEFAULT_AVD])
    expect(args.join(' ')).toContain('-gpu host')
    expect(args.join(' ')).toContain('-feature -Vulkan')
    expect(args.join(' ')).toContain('-memory 4096')
  })
})
