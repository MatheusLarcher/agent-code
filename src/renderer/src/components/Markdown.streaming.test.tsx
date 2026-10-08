import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

// Conta o que o react-markdown processa: o critério é que, no streaming, só o
// bloco que cresce seja processado de novo — não a mensagem inteira.
const processed = vi.hoisted(() => [] as string[])
vi.mock('react-markdown', async (importOriginal) => {
  const real = await importOriginal<typeof import('react-markdown')>()
  const Real = real.default
  return {
    ...real,
    default: (props: Parameters<typeof Real>[0]) => {
      processed.push(String(props.children))
      return Real(props)
    }
  }
})

import { Markdown } from './Markdown'

afterEach(cleanup)

// Cada parágrafo passa do mínimo para dividir (markdownBlocks.ts): já na 1ª render há blocos.
const paragraph = (n: number): string => `Parágrafo ${n}: ` + 'palavra '.repeat(80).trim() + '.'

describe('Markdown no streaming — memo por bloco', () => {
  it('um pedaço novo no fim reprocessa só o último bloco', () => {
    const start = [paragraph(1), paragraph(2), paragraph(3)].join('\n\n')
    const { container, rerender } = render(<Markdown text={start} />)
    expect(processed).toHaveLength(3)
    expect(container.querySelectorAll('p')).toHaveLength(3)
    processed.length = 0
    rerender(<Markdown text={`${start} mais um pedaço`} />)
    expect(processed).toHaveLength(1)
    expect(processed[0]).toMatch(/^Parágrafo 3:.*mais um pedaço$/)
    processed.length = 0
    rerender(<Markdown text={`${start} mais um pedaço\n\n${paragraph(4)}`} />)
    // O bloco 3 não mudou de texto; só o novo (o 4) é processado.
    expect(processed).toEqual([paragraph(4)])
    expect(container.querySelectorAll('p')).toHaveLength(4)
  })

  it('o borrado continua a numeração entre os blocos e não anima de novo o que já estava na tela', () => {
    const start = [paragraph(1), paragraph(2)].join('\n\n')
    const { container, rerender } = render(<Markdown text={start} blur />)
    const firstSpans = [...container.querySelectorAll<HTMLElement>('p:first-child .ca-w')]
    expect(firstSpans.length).toBeGreaterThan(20)
    const before = firstSpans.map((span) => span.style.getPropertyValue('--i'))
    rerender(<Markdown text={`${start}\n\n${paragraph(3)}`} blur />)
    // O primeiro bloco nem foi re-renderizado: os mesmos nós, o mesmo atraso.
    const after = [...container.querySelectorAll<HTMLElement>('p:first-child .ca-w')]
    expect(after[0]).toBe(firstSpans[0])
    expect(after.map((span) => span.style.getPropertyValue('--i'))).toEqual(before)
    // O bloco novo começa do zero de atraso (as palavras de antes já estavam pintadas).
    const third = container.querySelectorAll<HTMLElement>('p')[2]
    expect(third.querySelector<HTMLElement>('.ca-w')?.style.getPropertyValue('--i')).toBe('0')
  })
})
