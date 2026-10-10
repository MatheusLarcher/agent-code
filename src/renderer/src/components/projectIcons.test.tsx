import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { OfficeChatFloat } from '../office3d/OfficeChatFloat'
import { ProjectIconsContext } from './projectIcons'

afterEach(cleanup)

const ICON = 'data:image/png;base64,AAAA'
const chat = (icons: Record<string, string | null>): HTMLElement =>
  render(
    <ProjectIconsContext.Provider value={icons}>
      <OfficeChatFloat conversation={{ id: 'c1', title: 'Loja', cwd: 'C:\\proj\\loja' }} onLocate={() => {}}>
        <div />
      </OfficeChatFloat>
    </ProjectIconsContext.Provider>
  ).container

describe('ícone do projeto ao lado do nome no chat', () => {
  it('com ícone, a imagem dele antes do nome; sem ícone, a pasta', () => {
    const pill = chat({ 'C:\\proj\\loja': ICON }).querySelector('.o3d-chat-project')!
    expect(pill.textContent).toBe('loja')
    expect(pill.querySelector('.project-name-icon img')?.getAttribute('src')).toBe(ICON)
    cleanup()
    const none = chat({}).querySelector('.o3d-chat-project')!
    expect(none.querySelector('.project-name-icon img')).toBeNull()
    expect(none.querySelector('.project-name-icon svg')).not.toBeNull()
  })
})
