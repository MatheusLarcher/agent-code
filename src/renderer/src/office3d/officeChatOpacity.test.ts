import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(__dirname, 'office3d.css'), 'utf8')
const planning = readFileSync(resolve(__dirname, '..', 'planning/planningChat.css'), 'utf8')

describe('chat flutuante do Escritório quase opaco no máximo', () => {
  it('maximizado, minimizado e minimizado em foco: 96% × a opacidade do controle', () => {
    const rule = /((?:\.o3d-chat\.pl-chat-float[^{,]*,\s*)+\.o3d-chat\.pl-chat-float[^{]*)\{([^}]*)\}/.exec(css)
    expect(rule?.[2]).toMatch(/--pl-chat-fill: calc\(96% \* var\(--chat-bg-alpha, 1\)\);/)
    const selectors = rule![1].split(',').map((s) => s.trim())
    expect(selectors).toEqual([
      '.o3d-chat.pl-chat-float',
      '.o3d-chat.pl-chat-float.minimized',
      '.o3d-chat.pl-chat-float.minimized:hover',
      '.o3d-chat.pl-chat-float.minimized:focus-within'
    ])
  })

  it('a caixa de digitação nunca passa de 100% (color-mix inválido a deixaria transparente)', () => {
    expect(css).toMatch(/\.o3d-chat\.pl-chat-float \.composer-row \{[^}]*min\(100%, max\(calc\(var\(--pl-chat-fill\) \+ 10%\), 50%\)\)/)
  })

  it('o Planejamento continua translúcido (78% / 40%)', () => {
    expect(planning).toMatch(/\.pl-chat-float \{[^}]*--pl-chat-fill: calc\(78% \* var\(--chat-bg-alpha, 1\)\);/)
    expect(planning).toMatch(/\.pl-chat-float\.minimized \{[^}]*--pl-chat-fill: calc\(40% \* var\(--chat-bg-alpha, 1\)\);/)
  })
})
