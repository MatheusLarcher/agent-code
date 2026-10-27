import { describe, expect, it } from 'vitest'
import { insertOrgInstructions, insertOrgInstructionsInBody, ORG_INSTRUCTIONS_HEADER, withOrgInstructionsAppend } from './orgInstructions'

const SYSTEM = "# Harness\n - Reference code as `file_path:line_number` — it's clickable.\n\nWrite code that reads like the surrounding code: x"

describe('instruções da organização', () => {
  it('insere no formato exato da sessão Claude, na âncora do Harness', () => {
    const r = insertOrgInstructions(SYSTEM, '  Responda em português.  ')
    expect(r.inserted).toBe(true)
    expect(r.text).toContain(
      `it's clickable.${ORG_INSTRUCTIONS_HEADER}\n\n<organizationInstructions>Responda em português.</organizationInstructions>Write code that reads like`
    )
  })

  it('campo vazio, sem âncora ou bloco já presente: não insere', () => {
    expect(insertOrgInstructions(SYSTEM, '   ').inserted).toBe(false)
    expect(insertOrgInstructions('prompt próprio', 'x').inserted).toBe(false)
    const once = insertOrgInstructions(SYSTEM, 'x').text
    expect(insertOrgInstructions(once, 'x')).toEqual({ text: once, inserted: false })
  })

  it('no corpo da Messages API acha o bloco de sistema certo', () => {
    const body = { system: [{ type: 'text', text: 'outro' }, { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }] }
    expect(insertOrgInstructionsInBody(body, 'Regra A')).toBe(true)
    expect(body.system[0].text).toBe('outro')
    expect(body.system[1].text).toContain('<organizationInstructions>Regra A</organizationInstructions>')
    expect(body.system[1]).toHaveProperty('cache_control')
    const str = { system: SYSTEM }
    expect(insertOrgInstructionsInBody(str, 'Regra B')).toBe(true)
  })

  it('para Ollama/DeepSeek vai no fim do append', () => {
    expect(withOrgInstructionsAppend('base', '')).toBe('base')
    expect(withOrgInstructionsAppend('base', 'Regra')).toMatch(/^base\n\nCRITICAL: .*<organizationInstructions>Regra<\/organizationInstructions>$/s)
  })
})
