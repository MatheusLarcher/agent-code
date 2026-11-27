import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PermissionModal } from './PermissionModal'

afterEach(cleanup)

describe('PermissionModal — quem pede', () => {
  it('pedido do agente principal x de um agente do time', () => {
    render(<PermissionModal request={{ id: '1', toolName: 'Bash', input: {} }} onRespond={() => undefined} />)
    expect(screen.getByText(/O agente quer executar/)).toBeTruthy()
    cleanup()
    render(<PermissionModal request={{ id: '2', toolName: 'Bash', input: {}, agentId: 'sub-1' }} onRespond={() => undefined} />)
    expect(screen.getByText(/Um agente do time quer executar/)).toBeTruthy()
  })
})
