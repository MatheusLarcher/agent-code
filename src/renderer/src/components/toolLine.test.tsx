import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { CentralActivity } from '@shared/central'
import { ChatStepLine } from './ChatStepLine'
import { shortPath, toolKind, toolTarget } from './toolLine'

afterEach(() => cleanup())

describe('toolLine — a linha mono das ações do grupo aberto', () => {
  it('rótulo em pt por ferramenta; MCP sem o prefixo', () => {
    expect(['Grep', 'Glob', 'Read', 'Edit', 'Write', 'Bash', 'WebFetch'].map(toolKind)).toEqual(['busca', 'busca', 'leu', 'editou', 'escreveu', 'bash', 'web'])
    expect(toolKind('mcp__browser__browser_click')).toBe('browser_click')
  })

  it('alvo: padrão da busca, caminho curto, 1ª linha do comando, URL', () => {
    expect(toolTarget('Grep', { pattern: 'setShirtColor|shirtHex' })).toBe('setShirtColor|shirtHex')
    expect(toolTarget('Read', { file_path: 'C:\\GitHub\\agent-code\\src\\office3d\\agentBody.ts' })).toBe('office3d/agentBody.ts')
    expect(toolTarget('Bash', { command: 'git show --stat 36af851\necho fim' })).toBe('git show --stat 36af851')
    expect(toolTarget('WebFetch', { url: 'https://x.dev/a' })).toBe('https://x.dev/a')
    expect(toolTarget('Grep', null)).toBe('')
    expect(shortPath('a.ts')).toBe('a.ts')
  })
})

describe('ChatStepLine — status sem duplicar a linha ao vivo', () => {
  const activity = { text: '', count: 1, segments: [], now: 'procurando "setGlow"…' } as unknown as CentralActivity
  const line = (live: boolean) =>
    render(<ChatStepLine activity={activity} pills={[]} icon="find" running live={live} open={false} onToggle={() => {}} fallback="" animate={false} />).container

  it('sem a linha ao vivo: spinner e "agora: …" no passo', () => {
    const c = line(false)
    expect(c.querySelector('.central-spin')).toBeTruthy()
    expect(c.querySelector('.central-sum')?.textContent).toBe('agora: procurando "setGlow"…')
  })

  it('com a linha ao vivo: nem spinner nem "agora: …"', () => {
    const c = line(true)
    expect(c.querySelector('.central-spin')).toBeNull()
    expect(c.querySelector('.central-sum')?.textContent).toBe('')
  })
})
