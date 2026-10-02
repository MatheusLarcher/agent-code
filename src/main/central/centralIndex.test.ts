// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { buildCentralIndex, clipText, displayPath } from './centralIndex'
import { CWD, SANDBOX_ROOT, exists, sbx, sum } from './centralTestKit'

// O resumidor fica em centralIndex.summary.test.ts; o orçamento, em centralIndex.budget.test.ts.

// ---------------------------------------------------------------------------
// clipText
// ---------------------------------------------------------------------------

describe('clipText', () => {
  it('junta tudo numa linha só', () => {
    expect(clipText('  uma\n\nlinha\t com   espaços \r\n e outra  ')).toBe('uma linha com espaços e outra')
  })

  it('troca {{midia:N}} por [anexo]', () => {
    expect(clipText('veja {{midia:1}} e {{midia:12}}{{midia:3}}')).toBe('veja [anexo] e [anexo][anexo]')
    expect(clipText('{{midia:1}}')).toBe('[anexo]')
  })

  it('texto de até 200 caracteres passa inteiro; acima disso corta em 200 com reticências', () => {
    const exact = 'a'.repeat(200)
    expect(clipText(exact)).toBe(exact)
    const cut = clipText('b'.repeat(500))
    expect(cut).toHaveLength(200)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut).toBe('b'.repeat(199) + '…')
    expect(clipText('c'.repeat(201))).toBe('c'.repeat(199) + '…')
  })

  it('o corte conta o texto já normalizado (marcador e espaços não gastam o limite à toa)', () => {
    const text = `{{midia:1}}${'\n'.repeat(300)}${'d'.repeat(100)}`
    expect(clipText(text)).toBe(`[anexo] ${'d'.repeat(100)}`)
  })

  it('não corta um emoji no meio', () => {
    const emoji = clipText('a'.repeat(198) + '😀' + 'zzz')
    expect(emoji).toBe('a'.repeat(198) + '…')
    expect(emoji).not.toMatch(/[\ud800-\udbff]/)
    // O emoji inteiro que cabe antes do corte fica.
    expect(clipText('a'.repeat(197) + '😀' + 'zzz')).toBe('a'.repeat(197) + '😀' + '…')
  })

  it('não deixa espaço antes das reticências', () => {
    expect(clipText('g'.repeat(198) + ' ' + 'h'.repeat(50))).toBe('g'.repeat(198) + '…')
  })

  it('o que não é texto vira vazio', () => {
    expect(clipText(undefined)).toBe('')
    expect(clipText(null)).toBe('')
    expect(clipText(42)).toBe('')
    expect(clipText({ text: 'x' })).toBe('')
  })

  it('tira caracteres de controle', () => {
    expect(clipText('a\u0000b\u001b[31mc\u007fd')).toBe('a b [31mc d')
  })
})

// ---------------------------------------------------------------------------
// displayPath
// ---------------------------------------------------------------------------

describe('displayPath', () => {
  it('dentro da pasta da conversa: relativo, com barras normais', () => {
    expect(displayPath('C:\\Users\\x\\proj\\src\\a.ts', CWD)).toBe('src/a.ts')
    expect(displayPath('C:\\Users\\x\\proj\\a.ts', `${CWD}\\`)).toBe('a.ts')
    expect(displayPath('/home/u/proj/src/deep/a.ts', '/home/u/proj')).toBe('src/deep/a.ts')
    expect(displayPath('C:/Users/x/proj/src/a.ts', CWD)).toBe('src/a.ts')
  })

  it('maiúsculas e minúsculas não importam na pasta; o resto do caminho mantém a grafia', () => {
    expect(displayPath('c:\\users\\X\\PROJ\\Src\\a.ts', CWD)).toBe('Src/a.ts')
  })

  it('fora da pasta: só o nome do arquivo', () => {
    expect(displayPath('C:\\other\\z.ts', CWD)).toBe('z.ts')
    expect(displayPath('D:\\Users\\x\\proj\\a.ts', CWD)).toBe('a.ts')
    expect(displayPath('/home/u/other/z.ts', '/home/u/proj')).toBe('z.ts')
  })

  it('pasta irmã com o mesmo prefixo não é "dentro"', () => {
    expect(displayPath('C:\\Users\\x\\proj-2\\a.ts', CWD)).toBe('a.ts')
  })

  it('".." é resolvido antes de decidir se está dentro', () => {
    expect(displayPath('C:\\Users\\x\\proj\\..\\other\\a.ts', CWD)).toBe('a.ts')
    expect(displayPath('C:\\Users\\x\\proj\\sub\\..\\..\\a.ts', CWD)).toBe('a.ts')
    expect(displayPath('C:\\Users\\x\\proj\\sub\\..\\lib\\a.ts', CWD)).toBe('lib/a.ts')
  })

  it('caminho relativo já é relativo à pasta da conversa', () => {
    expect(displayPath('src\\a.ts', CWD)).toBe('src/a.ts')
    expect(displayPath('./src/a.ts', CWD)).toBe('src/a.ts')
    expect(displayPath('../fora/a.ts', CWD)).toBe('a.ts')
  })

  it('sem pasta de conversa: só o nome', () => {
    expect(displayPath('C:\\Users\\x\\proj\\a.ts', '')).toBe('a.ts')
  })

  it('o caminho igual à própria pasta mostra o nome dela (nunca vazio)', () => {
    expect(displayPath(CWD, CWD)).toBe('proj')
    expect(displayPath(`${CWD}\\`, CWD)).toBe('proj')
  })
})

// ---------------------------------------------------------------------------
// buildCentralIndex
// ---------------------------------------------------------------------------

describe('buildCentralIndex', () => {
  it('agrupa por pasta, com nome da pasta; projetos e conversas do mais recente para o mais antigo', () => {
    const index = buildCentralIndex(
      [
        sum('a1', { updatedAt: 10 }),
        sum('b1', { cwd: 'C:\\work\\beta', project: 'beta', updatedAt: 50 }),
        sum('a2', { updatedAt: 30 }),
        sum('c1', { cwd: 'C:\\work\\gamma', project: 'gamma', updatedAt: 20 })
      ],
      { sandboxRoot: SANDBOX_ROOT, exists }
    )
    expect(index.projects.map((p) => p.name)).toEqual(['beta', 'alpha', 'gamma'])
    expect(index.projects.map((p) => p.updatedAt)).toEqual([50, 30, 20])
    const alpha = index.projects.find((p) => p.name === 'alpha')!
    expect(alpha).toMatchObject({ cwd: 'C:\\work\\alpha', sandbox: false, updatedAt: 30 })
    expect(alpha.conversations.map((c) => c.convId)).toEqual(['a2', 'a1'])
    expect(alpha.recentTitles).toEqual(['Título a2', 'Título a1'])
  })

  it('byId tem toda conversa do índice', () => {
    const a = sum('a')
    const b = sum('b', { cwd: 'C:\\work\\beta', project: 'beta' })
    const index = buildCentralIndex([a, b], { sandboxRoot: SANDBOX_ROOT, exists })
    expect(index.byId.size).toBe(2)
    expect(index.byId.get('a')).toBe(a)
    expect(index.byId.get('b')).toBe(b)
  })

  it('recentTitles: os títulos das 5 conversas mais recentes do projeto', () => {
    const many = Array.from({ length: 8 }, (_, i) => sum(`c${i}`, { updatedAt: 100 + i }))
    const [alpha] = buildCentralIndex(many, { sandboxRoot: SANDBOX_ROOT, exists }).projects
    expect(alpha.conversations).toHaveLength(8)
    expect(alpha.recentTitles).toEqual(['Título c7', 'Título c6', 'Título c5', 'Título c4', 'Título c3'])
  })

  it('recentTitles pula título vazio', () => {
    const [alpha] = buildCentralIndex([sum('a', { title: '', updatedAt: 3 }), sum('b', { updatedAt: 2 })], {
      sandboxRoot: SANDBOX_ROOT,
      exists
    }).projects
    expect(alpha.recentTitles).toEqual(['Título b'])
  })

  it('empate de data: ordem estável (por id, nome e pasta)', () => {
    const items = [
      sum('z', { updatedAt: 5 }),
      sum('m', { updatedAt: 5 }),
      sum('b1', { cwd: 'C:\\work\\beta', project: 'beta', updatedAt: 5 })
    ]
    const forward = buildCentralIndex(items, { sandboxRoot: SANDBOX_ROOT, exists })
    const backward = buildCentralIndex([...items].reverse(), { sandboxRoot: SANDBOX_ROOT, exists })
    expect(forward.projects.map((p) => p.name)).toEqual(['alpha', 'beta'])
    expect(forward.projects[0].conversations.map((c) => c.convId)).toEqual(['m', 'z'])
    expect(JSON.stringify(backward.projects)).toBe(JSON.stringify(forward.projects))
  })

  it('pasta que não existe nesta máquina fica de fora; projeto sem conversa restante não aparece', () => {
    const present = new Set(['C:\\work\\alpha'])
    const index = buildCentralIndex(
      [sum('a1'), sum('g1', { cwd: 'C:\\work\\gone', project: 'gone' }), sum('g2', { cwd: 'C:\\work\\gone', project: 'gone' })],
      { sandboxRoot: SANDBOX_ROOT, exists: (p) => present.has(p) }
    )
    expect(index.projects.map((p) => p.name)).toEqual(['alpha'])
    expect([...index.byId.keys()]).toEqual(['a1'])
  })

  it('consulta a pasta uma vez só por caminho', () => {
    const probe = vi.fn(() => true)
    buildCentralIndex([sum('a1'), sum('a2'), sum('a3'), sum('b1', { cwd: 'C:\\work\\beta', project: 'beta' })], {
      sandboxRoot: SANDBOX_ROOT,
      exists: probe
    })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(probe).toHaveBeenCalledWith('C:\\work\\alpha')
    expect(probe).toHaveBeenCalledWith('C:\\work\\beta')
  })

  it('um exists que lança conta como pasta ausente', () => {
    const index = buildCentralIndex([sum('a1'), sum('b1', { cwd: 'C:\\work\\beta', project: 'beta' })], {
      sandboxRoot: SANDBOX_ROOT,
      exists: (p) => {
        if (p.endsWith('beta')) throw new Error('EPERM')
        return true
      }
    })
    expect(index.projects.map((p) => p.name)).toEqual(['alpha'])
  })

  it('sem conversas: índice vazio', () => {
    const index = buildCentralIndex([], { sandboxRoot: SANDBOX_ROOT, exists })
    expect(index.projects).toEqual([])
    expect(index.byId.size).toBe(0)
  })

  it('aceita qualquer iterável (o store passa os valores de um Map)', () => {
    const map = new Map([['a1', sum('a1')]])
    expect(buildCentralIndex(map.values(), { sandboxRoot: SANDBOX_ROOT, exists }).byId.size).toBe(1)
  })
})

describe('buildCentralIndex — sandbox', () => {
  it('todas as conversas do sandbox formam UM grupo, com a pasta raiz; cada resumo guarda a sua subpasta', () => {
    const s1 = sbx('s1', '2026-10-01_09-00_aaaa', { updatedAt: 100 })
    const s2 = sbx('s2', '2026-10-02_09-00_bbbb', { updatedAt: 300 })
    const s3 = sbx('s3', '2026-10-02_10-00_cccc', { updatedAt: 200 })
    const index = buildCentralIndex([sum('a1', { updatedAt: 250 }), s1, s2, s3], { sandboxRoot: SANDBOX_ROOT, exists })
    expect(index.projects.map((p) => p.name)).toEqual(['sandbox', 'alpha'])
    const group = index.projects[0]
    expect(group).toMatchObject({ sandbox: true, name: 'sandbox', cwd: SANDBOX_ROOT, updatedAt: 300 })
    expect(group.conversations.map((c) => c.convId)).toEqual(['s2', 's3', 's1'])
    expect(group.conversations.map((c) => c.cwd)).toEqual([
      `${SANDBOX_ROOT}\\2026-10-02_09-00_bbbb`,
      `${SANDBOX_ROOT}\\2026-10-02_10-00_cccc`,
      `${SANDBOX_ROOT}\\2026-10-01_09-00_aaaa`
    ])
    expect(group.recentTitles).toEqual(['Título s2', 'Título s3', 'Título s1'])
    expect(index.projects.filter((p) => p.sandbox)).toHaveLength(1)
  })

  it('o grupo do sandbox entra na ordem de recência como qualquer projeto', () => {
    const index = buildCentralIndex([sum('a1', { updatedAt: 900 }), sbx('s1', 'x', { updatedAt: 100 })], {
      sandboxRoot: SANDBOX_ROOT,
      exists
    })
    expect(index.projects.map((p) => p.name)).toEqual(['alpha', 'sandbox'])
  })

  it('subpasta do sandbox que não existe mais sai; sem nenhuma restante, o grupo some', () => {
    const alive = `${SANDBOX_ROOT}\\vivo`
    const index = buildCentralIndex([sbx('s1', 'vivo'), sbx('s2', 'morto')], {
      sandboxRoot: SANDBOX_ROOT,
      exists: (p) => p === alive
    })
    expect(index.projects).toHaveLength(1)
    expect(index.projects[0].conversations.map((c) => c.convId)).toEqual(['s1'])
    expect(buildCentralIndex([sbx('s2', 'morto')], { sandboxRoot: SANDBOX_ROOT, exists: () => false }).projects).toEqual([])
  })

  it('não consulta a pasta raiz do sandbox, só as subpastas das conversas', () => {
    const probe = vi.fn(() => true)
    buildCentralIndex([sbx('s1', 'a'), sbx('s2', 'b')], { sandboxRoot: SANDBOX_ROOT, exists: probe })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(probe).not.toHaveBeenCalledWith(SANDBOX_ROOT)
  })

  it('uma pasta de projeto que por acaso se chama "sandbox" continua projeto normal', () => {
    const index = buildCentralIndex(
      [sum('p1', { cwd: 'C:\\work\\sandbox', project: 'sandbox' }), sbx('s1', 'a')],
      { sandboxRoot: SANDBOX_ROOT, exists }
    )
    expect(index.projects).toHaveLength(2)
    expect(index.projects.filter((p) => p.sandbox)).toHaveLength(1)
  })
})
