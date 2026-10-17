/** Logo do projeto: pede a rota da ponte; sem logo (erro da imagem) volta à pasta e não pede de novo. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { client } from '../app/runtime'
import { resetApp } from '../app/testSupport'
import { ProjectLogo } from './ProjectLogo'

describe('ProjectLogo', () => {
  afterEach(cleanup)

  it('mostra a imagem da rota e, se falhar, o ícone de pasta (também na próxima montagem)', () => {
    resetApp()
    client.store.set({ base: 'http://pc:1', token: 't' })
    const first = render(<ProjectLogo cwd={"C:\\GitHub\\semlogo"} size={18} />)
    const img = first.container.querySelector('img.proj-logo') as HTMLImageElement
    expect(img.src).toContain('/api/project-icon?cwd=' + encodeURIComponent('C:\\GitHub\\semlogo'))
    fireEvent.error(img)
    expect(first.container.querySelector('img')).toBeNull()
    expect(first.container.querySelector('.proj-logo-glyph')).toBeTruthy()
    first.unmount()
    const again = render(<ProjectLogo cwd={"C:\\GitHub\\semlogo"} size={18} />)
    expect(again.container.querySelector('img')).toBeNull()
    // Outra pasta no mesmo componente (cabeçalho trocando de conversa) volta a tentar.
    again.rerender(<ProjectLogo cwd={"C:\\GitHub\\outra"} size={18} />)
    expect(again.container.querySelector('img.proj-logo')).toBeTruthy()
  })
})
