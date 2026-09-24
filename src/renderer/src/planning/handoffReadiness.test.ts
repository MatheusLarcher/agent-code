import { describe, expect, it } from 'vitest'
import { buildDraftHandoff, demoteHeadings, handoffReadiness, isOpenAmbiguity } from './handoffReadiness'
import type { PlanMediaDto } from '@shared/ipc'
import { makeCard, makePlan, PLAN_DIR } from './planningTestUtils'

describe('handoffReadiness', () => {
  it('plano sem ambiguidade: nenhum bloqueio; avisa etapa sem card e etapas não concluídas', () => {
    const { blockers, warnings } = handoffReadiness(makePlan())
    expect(blockers).toEqual([])
    expect(warnings.map((w) => [w.kind, w.ref])).toEqual([
      ['etapa-sem-card', 'entrega'],
      ['etapa-nao-concluida', 'desenho'],
      ['etapa-nao-concluida', 'entrega']
    ])
    expect(warnings[1].text).toBe('A etapa "Desenhar a solução" ainda está pendente.')
    expect(warnings[2].text).toBe('A etapa "Entregar" ainda está em andamento.')
  })

  it('ambiguidade aberta bloqueia (status ausente ou "aberta"); resolvida não', () => {
    const plan = makePlan()
    plan.cards.push(
      makeCard('amb-b', { tipo: 'ambiguidade', titulo: 'Pix ou boleto?', status: 'aberta', etapa: 'desenho' }),
      makeCard('amb-a', { tipo: 'ambiguidade', titulo: 'Sem status', etapa: 'desenho' }),
      makeCard('amb-c', { tipo: 'ambiguidade', titulo: 'Resolvida', status: 'resolvida', etapa: 'desenho' })
    )
    const { blockers } = handoffReadiness(plan)
    expect(blockers.map((b) => [b.kind, b.ref])).toEqual([
      ['ambiguidade-aberta', 'amb-a'],
      ['ambiguidade-aberta', 'amb-b']
    ])
    expect(blockers[1].text).toBe('Ambiguidade aberta: "Pix ou boleto?"')
    expect(isOpenAmbiguity(plan.cards.find((c) => c.id === 'amb-c')!)).toBe(false)
    expect(isOpenAmbiguity(makeCard('x', { tipo: 'nota' }))).toBe(false)
  })

  it('roteiro vazio e cards inválidos viram aviso', () => {
    const plan = makePlan({
      roteiro: { titulo: 'Vazio', rev: 1, etapas: [] },
      cards: [],
      invalid: [{ file: 'cards/quebrado.md', error: 'sem frontmatter' }]
    })
    const { blockers, warnings } = handoffReadiness(plan)
    expect(blockers).toEqual([])
    expect(warnings.map((w) => w.kind)).toEqual(['roteiro-vazio', 'card-invalido'])
    expect(warnings[1].text).toContain('cards/quebrado.md')
    expect(warnings[1].text).toContain('sem frontmatter')
  })

  it('tudo concluído, com cards e sem ambiguidade: nada a dizer', () => {
    const plan = makePlan({
      roteiro: { titulo: 'P', rev: 1, etapas: [{ id: 'requisitos', titulo: 'R', status: 'concluida' }] },
      cards: [makeCard('login', { etapa: 'requisitos' })]
    })
    expect(handoffReadiness(plan)).toEqual({ blockers: [], warnings: [] })
  })
})

describe('buildDraftHandoff', () => {
  function richPlan() {
    const plan = makePlan()
    plan.cards = [
      makeCard('login', { etapa: 'requisitos', titulo: 'Login com SSO', corpo: 'Usar o IdP da empresa.\n' }),
      makeCard('banco', { tipo: 'decisao', etapa: 'desenho', titulo: 'Usar Postgres', corpo: '# Por quê\nJá temos operação.\n' }),
      makeCard('cache', {
        tipo: 'sugestao',
        etapa: 'desenho',
        titulo: 'Cache com Redis',
        fonte: 'https://redis.io/docs/',
        corpo: 'Reduz latência.'
      }),
      makeCard('amb-pix', {
        tipo: 'ambiguidade',
        etapa: 'desenho',
        titulo: 'Pix ou boleto?',
        status: 'resolvida',
        corpo: '## Decisão (2026-09-22)\n\nPix.'
      }),
      makeCard('amb-frete', { tipo: 'ambiguidade', etapa: 'entrega', titulo: 'Frete grátis?', status: 'aberta' }),
      makeCard('solto', { tipo: 'nota', titulo: 'Lembrar do LGPD', corpo: 'Ver com o jurídico.' })
    ]
    return plan
  }

  it('é determinístico: o mesmo plano dá o mesmo texto, em qualquer ordem de cards', () => {
    const a = richPlan()
    const b = richPlan()
    b.cards.reverse()
    expect(buildDraftHandoff(a)).toBe(buildDraftHandoff(b))
  })

  it('traz objetivo, etapas na ordem com os cards, decisões, sugestões com fonte e ambiguidades', () => {
    const md = buildDraftHandoff(richPlan())
    expect(md.startsWith('# Implementação: Plano de teste\n')).toBe(true)
    // A pasta real do plano, como o main a devolveu (plan.dir).
    expect(md).toContain(`O plano detalhado está em \`${PLAN_DIR}\``)
    expect(md).not.toContain('docs/spec')
    expect(md).toContain('## Objetivo')
    expect(md).toContain('Entregar as 3 etapas do roteiro, na ordem')

    // Etapas na ordem do roteiro, cada uma com os seus cards.
    const etapas = md.indexOf('## Etapas, na ordem')
    const e1 = md.indexOf('1. **Levantar requisitos** (`requisitos`) — concluída')
    const e2 = md.indexOf('2. **Desenhar a solução** (`desenho`) — pendente')
    const e3 = md.indexOf('3. **Entregar** (`entrega`) — em andamento')
    expect(etapas).toBeGreaterThan(-1)
    expect(etapas < e1 && e1 < e2 && e2 < e3).toBe(true)
    expect(md).toContain('   - Requisito: Login com SSO (`cards/login.md`)')
    expect(md).toContain('   - Decisão: Usar Postgres (`cards/banco.md`)')
    expect(md.indexOf('   - Decisão: Usar Postgres')).toBeLessThan(md.indexOf('   - Sugestão: Cache com Redis'))
    expect(md).toContain('## Cards fora das etapas\n\n- Nota: Lembrar do LGPD (`cards/solto.md`)')

    // Decisão com o porquê (títulos do corpo rebaixados para não brigar com as seções).
    expect(md).toContain('## Decisões (com o porquê)\n\n### Usar Postgres (`cards/banco.md`)\n\n#### Por quê\nJá temos operação.')
    expect(md).toContain('## Sugestões (com fonte)\n\n### Cache com Redis (`cards/cache.md`)\n\nFonte: https://redis.io/docs/')
    expect(md).toContain('## Ambiguidades resolvidas\n\n### Pix ou boleto? (`cards/amb-pix.md`)\n\n##### Decisão (2026-09-22)')
    expect(md).toContain('## Ambiguidades ainda abertas\n\n- **Frete grátis?** (`cards/amb-frete.md`) — sem decisão')
  })

  it('termina com a instrução de declarar as etapas como plano e consultar a pasta real do plano', () => {
    const md = buildDraftHandoff(richPlan())
    const how = md.slice(md.indexOf('## Como trabalhar'))
    expect(how).toContain('declare as etapas acima como o seu plano (TodoWrite ou TaskCreate)')
    expect(how).toContain('sem replanejar')
    expect(how).toContain(`Consulte \`${PLAN_DIR}\``)
  })

  it('sem ambiguidade aberta não há a seção; roteiro vazio muda o objetivo', () => {
    const md = buildDraftHandoff(makePlan())
    expect(md).not.toContain('Ambiguidades ainda abertas')
    const vazio = buildDraftHandoff(makePlan({ roteiro: { titulo: '', rev: 1, etapas: [] }, cards: [] }))
    expect(vazio.startsWith('# Implementação: plano\n')).toBe(true)
    expect(vazio).toContain('O roteiro ainda não tem etapas')
    expect(vazio).not.toContain('## Etapas, na ordem')
  })
})

describe('buildDraftHandoff com mídia', () => {
  const MIDIA = `${PLAN_DIR}\\midia`
  function media(name: string, over: Partial<PlanMediaDto> = {}): PlanMediaDto {
    return { name, path: `${MIDIA}\\${name}`, kind: 'imagem', size: 10, mediaType: 'image/png', ...over }
  }

  /** O texto que o rascunho gerava ANTES de existir mídia (capturado do código anterior). */
  const BEFORE_MEDIA = [
    '# Implementação: Plano de teste',
    '',
    `Esta conversa implementa o planejamento **Plano de teste**, feito com o usuário na Tela de Planejamento. O plano detalhado está em \`${PLAN_DIR}\`: \`_roteiro.md\` (as etapas, na ordem) e \`cards/\` (um arquivo por card).`,
    '',
    '## Objetivo',
    '',
    'Plano de teste. Entregar as 3 etapas do roteiro, na ordem, respeitando os requisitos e as decisões abaixo.',
    '',
    '## Etapas, na ordem',
    '',
    '1. **Levantar requisitos** (`requisitos`) — concluída',
    '   - Requisito: Login com SSO (`cards/login.md`)',
    '2. **Desenhar a solução** (`desenho`) — pendente',
    '   - Decisão: Usar Postgres (`cards/banco.md`)',
    '   - Sugestão: Cache com Redis (`cards/cache.md`)',
    '   - Ambiguidade: Pix ou boleto? (`cards/amb-pix.md`)',
    '3. **Entregar** (`entrega`) — em andamento',
    '   - Ambiguidade: Frete grátis? (`cards/amb-frete.md`)',
    '',
    '## Cards fora das etapas',
    '',
    '- Nota: Lembrar do LGPD (`cards/solto.md`)',
    '',
    '## Requisitos',
    '',
    '### Login com SSO (`cards/login.md`)',
    '',
    'Usar o IdP da empresa.',
    '',
    '## Decisões (com o porquê)',
    '',
    '### Usar Postgres (`cards/banco.md`)',
    '',
    '#### Por quê',
    'Já temos operação.',
    '',
    '## Sugestões (com fonte)',
    '',
    '### Cache com Redis (`cards/cache.md`)',
    '',
    'Fonte: https://redis.io/docs/',
    '',
    'Reduz latência.',
    '',
    '## Ambiguidades resolvidas',
    '',
    '### Pix ou boleto? (`cards/amb-pix.md`)',
    '',
    '##### Decisão (2026-09-22)',
    '',
    'Pix.',
    '',
    '## Ambiguidades ainda abertas',
    '',
    '- **Frete grátis?** (`cards/amb-frete.md`) — sem decisão: confirme com o usuário antes de implementar o que depende dela.',
    '',
    '## Notas',
    '',
    '### Lembrar do LGPD (`cards/solto.md`)',
    '',
    'Ver com o jurídico.',
    '',
    '## Como trabalhar',
    '',
    '- Antes de começar, declare as etapas acima como o seu plano (TodoWrite ou TaskCreate), na mesma ordem, e siga-as sem replanejar.',
    `- Consulte \`${PLAN_DIR}\` (roteiro e cards) sempre que precisar de detalhe: os cards são a fonte das decisões.`,
    '- Se o código real contradisser o plano, diga ao usuário o que encontrou e pergunte antes de desviar dele.',
    ''
  ].join('\n')

  function richPlan() {
    const plan = makePlan()
    plan.cards = [
      makeCard('login', { etapa: 'requisitos', titulo: 'Login com SSO', corpo: 'Usar o IdP da empresa.\n' }),
      makeCard('banco', { tipo: 'decisao', etapa: 'desenho', titulo: 'Usar Postgres', corpo: '# Por quê\nJá temos operação.\n' }),
      makeCard('cache', {
        tipo: 'sugestao',
        etapa: 'desenho',
        titulo: 'Cache com Redis',
        fonte: 'https://redis.io/docs/',
        corpo: 'Reduz latência.'
      }),
      makeCard('amb-pix', {
        tipo: 'ambiguidade',
        etapa: 'desenho',
        titulo: 'Pix ou boleto?',
        status: 'resolvida',
        corpo: '## Decisão (2026-09-22)\n\nPix.'
      }),
      makeCard('amb-frete', { tipo: 'ambiguidade', etapa: 'entrega', titulo: 'Frete grátis?', status: 'aberta' }),
      makeCard('solto', { tipo: 'nota', titulo: 'Lembrar do LGPD', corpo: 'Ver com o jurídico.' })
    ]
    return plan
  }

  it('plano sem mídia e sem anexo: exatamente o texto de antes (anexos [] também)', () => {
    expect(buildDraftHandoff(richPlan())).toBe(BEFORE_MEDIA)
    const vazios = richPlan()
    vazios.cards = vazios.cards.map((c) => ({ ...c, anexos: [] }))
    expect(buildDraftHandoff(vazios)).toBe(BEFORE_MEDIA)
  })

  it('card com anexos lista tipo + caminho absoluto; anexo sem arquivo sai "(arquivo não encontrado)"', () => {
    const plan = richPlan()
    plan.media = [media('a1b2c3-tela.png'), media('d4e5f6-contrato.pdf', { kind: 'pdf', mediaType: 'application/pdf' })]
    plan.cards[0] = { ...plan.cards[0], anexos: ['a1b2c3-tela.png', 'sumiu-planilha.xlsx'] }
    const md = buildDraftHandoff(plan)
    expect(md).toContain(
      [
        '### Login com SSO (`cards/login.md`)',
        '',
        'Usar o IdP da empresa.',
        '',
        'Anexos:',
        `- [Imagem] a1b2c3-tela.png — ${MIDIA}\\a1b2c3-tela.png`,
        '- [Planilha] sumiu-planilha.xlsx — (arquivo não encontrado)',
        ''
      ].join('\n')
    )
  })

  it('ambiguidade aberta e card de mídia também listam os anexos', () => {
    const plan = richPlan()
    plan.media = [media('a1b2c3-fluxo.png'), media('b2c3d4-demo.mp4', { kind: 'video', mediaType: 'video/mp4' })]
    plan.cards[4] = { ...plan.cards[4], anexos: ['a1b2c3-fluxo.png'] }
    plan.cards.push(makeCard('video', { tipo: 'midia', etapa: 'entrega', titulo: 'Demo gravada', anexos: ['b2c3d4-demo.mp4'] }))
    const md = buildDraftHandoff(plan)
    expect(md).toContain(
      `- **Frete grátis?** (\`cards/amb-frete.md\`) — sem decisão: confirme com o usuário antes de implementar o que depende dela.\n  - Anexo: [Imagem] a1b2c3-fluxo.png — ${MIDIA}\\a1b2c3-fluxo.png`
    )
    expect(md).toContain('   - Mídia: Demo gravada (`cards/video.md`)')
    expect(md).toContain(
      `## Cards de mídia\n\n### Demo gravada (\`cards/video.md\`)\n\n_(sem texto no card)_\n\nAnexos:\n- [Vídeo] b2c3d4-demo.mp4 — ${MIDIA}\\b2c3d4-demo.mp4\n`
    )
  })

  it('termina com "Mídias do plano (abra com Read)": todas as mídias, por nome, órfã marcada', () => {
    const plan = richPlan()
    plan.media = [media('z9-orfa.docx', { kind: 'documento' }), media('a1b2c3-tela.png')]
    plan.cards[0] = { ...plan.cards[0], anexos: ['a1b2c3-tela.png'] }
    const md = buildDraftHandoff(plan)
    const sec = md.indexOf('## Mídias do plano (abra com Read)')
    expect(sec).toBeGreaterThan(md.indexOf('## Como trabalhar'))
    const tail = md.slice(sec)
    expect(tail).toContain('Read')
    expect(tail).toContain(
      `- [Imagem] a1b2c3-tela.png — ${MIDIA}\\a1b2c3-tela.png\n- [Documento] z9-orfa.docx — ${MIDIA}\\z9-orfa.docx (sem card)\n`
    )
    expect(md.endsWith('(sem card)\n')).toBe(true)
    // Mídia sem card nenhum citando ainda muda o texto (a seção final aparece).
    const soOrfa = richPlan()
    soOrfa.media = [media('z9-orfa.docx', { kind: 'documento' })]
    expect(buildDraftHandoff(soOrfa).startsWith(BEFORE_MEDIA)).toBe(true)
    expect(buildDraftHandoff(soOrfa)).not.toBe(BEFORE_MEDIA)
  })
})

describe('handoffReadiness com mídia', () => {
  it('anexo que não está em plan.media vira AVISO (não bloqueio); o que existe, nada', () => {
    const plan = makePlan({
      roteiro: { titulo: 'P', rev: 1, etapas: [{ id: 'requisitos', titulo: 'R', status: 'concluida' }] },
      cards: [
        makeCard('login', { etapa: 'requisitos', titulo: 'Login', anexos: ['a1-tela.png', 'b2-sumiu.pdf'] }),
        makeCard('arq', { etapa: 'requisitos', tipo: 'midia', titulo: 'Arquivo', anexos: ['c3-foi.zip'] })
      ],
      media: [{ name: 'a1-tela.png', path: 'D:\\x\\midia\\a1-tela.png', kind: 'imagem', size: 1, mediaType: 'image/png' }]
    })
    const { blockers, warnings } = handoffReadiness(plan)
    expect(blockers).toEqual([])
    expect(warnings.map((w) => [w.kind, w.ref])).toEqual([
      ['anexo-ausente', 'arq'],
      ['anexo-ausente', 'login']
    ])
    expect(warnings[1].text).toContain('"b2-sumiu.pdf"')
    expect(warnings[1].text).toContain('midia/')
  })
})

describe('demoteHeadings', () => {
  it('rebaixa títulos, mas não dentro de bloco de código, e não passa de ######', () => {
    const text = '# A\ntexto #não\n```\n# comentário\n```\n##### B\n~~~\n## c\n~~~'
    expect(demoteHeadings(text, 2)).toBe('### A\ntexto #não\n```\n# comentário\n```\n###### B\n~~~\n## c\n~~~')
  })
})
