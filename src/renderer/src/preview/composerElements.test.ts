import { describe, expect, it } from 'vitest'
import type { PickedElement } from '@shared/ipc'
import { marksForTab } from './composerElements'

const el = (selector: string, tabId: string): PickedElement => ({
  selector,
  tabId,
  tagName: 'div',
  id: '',
  classes: '',
  text: '',
  html: '',
  url: '',
  tabName: tabId
})

describe('marksForTab', () => {
  it('número = posição no campo inteiro ("[elemento N]"), não na lista da aba', () => {
    const els = [el('#x', 'chrome'), el('#a', 'p1'), el('#y', 'p2'), el('#b', 'p1')]
    expect(marksForTab(els, 'p1')).toEqual([
      { selector: '#a', n: 2 },
      { selector: '#b', n: 4 }
    ])
    expect(marksForTab(els, 'p2')).toEqual([{ selector: '#y', n: 3 }])
    expect(marksForTab(els, 'nenhuma')).toEqual([])
  })
})
