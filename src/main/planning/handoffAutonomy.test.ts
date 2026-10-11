// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('./planningRoot', () => ({ planDirPath: (cwd: string, slug: string) => join(cwd, slug) }))

import {
  DEFAULT_HANDOFF_AUTONOMY,
  describeHandoffAutonomy,
  isDefaultHandoffAutonomy,
  parseHandoffAutonomy,
  readHandoffAutonomy
} from './handoffAutonomy'

let dir = ''
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ''
})

async function withCard(body: string | null): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'handoff-autonomy-'))
  await mkdir(join(dir, 'plano', 'cards'), { recursive: true })
  if (body !== null) await writeFile(join(dir, 'plano', 'cards', 'decisao-autonomia-handoff.md'), body)
  return dir
}

const front = '---\nid: "decisao-autonomia-handoff"\ntipo: "decisao"\n---\n'

describe('readHandoffAutonomy', () => {
  it('card ausente → padrão autônomo', async () => {
    const cwd = await withCard(null)
    expect(readHandoffAutonomy(cwd, 'plano')).toEqual(DEFAULT_HANDOFF_AUTONOMY)
  })

  it('card do plano real (Perguntas: nenhuma / Permissões: permitir tudo, exceto destrutivo) → padrão', async () => {
    const cwd = await withCard(`${front}Perguntas: nenhuma\nPermissões: permitir tudo, exceto destrutivo\n\nTexto livre.`)
    const a = readHandoffAutonomy(cwd, 'plano')
    expect(a).toEqual(DEFAULT_HANDOFF_AUTONOMY)
    expect(isDefaultHandoffAutonomy(a)).toBe(true)
  })

  it('"só o que listar" com 2 itens → lista', async () => {
    const cwd = await withCard(`${front}Perguntas: Só o que listar\n- migração do banco\n- nome da tabela nova\nPermissões: pedir como hoje\n`)
    expect(readHandoffAutonomy(cwd, 'plano')).toEqual({
      perguntas: { lista: ['migração do banco', 'nome da tabela nova'] },
      permissoes: 'como_hoje'
    })
  })

  it('card ilegível (sem as linhas) → padrão', async () => {
    const cwd = await withCard('\u0000\u0001 lixo binário sem campos')
    expect(readHandoffAutonomy(cwd, 'plano')).toEqual(DEFAULT_HANDOFF_AUTONOMY)
  })

  it('slug inválido não lança → padrão', () => {
    expect(readHandoffAutonomy('/nao/existe', '../fora')).toEqual(DEFAULT_HANDOFF_AUTONOMY)
  })
})

describe('parseHandoffAutonomy', () => {
  it('sem acento e maiúsculas, "como hoje"', () => {
    expect(parseHandoffAutonomy('PERGUNTAS: Como hoje\npermissoes: Pedir como hoje')).toEqual({ perguntas: 'como_hoje', permissoes: 'como_hoje' })
  })

  it('"só o que listar" sem itens cai em nenhuma', () => {
    expect(parseHandoffAutonomy('Perguntas: só o que listar\n\nPermissões: permitir tudo').perguntas).toBe('nenhuma')
  })

  it('descrição para o bloco do handoff', () => {
    const text = describeHandoffAutonomy({ perguntas: { lista: ['deploy'] }, permissoes: 'como_hoje' })
    expect(text).toContain('só o que listar')
    expect(text).toContain('- deploy')
    expect(text).toContain('pedir como hoje')
  })
})
