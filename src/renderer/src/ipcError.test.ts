import { describe, expect, it } from 'vitest'
import { ipcErrorMessage } from './ipcError'

describe('ipcErrorMessage', () => {
  it('remove o envelope técnico do invoke sem ocultar o diagnóstico', () => {
    expect(
      ipcErrorMessage(
        new Error("Error invoking remote method 'storage:retry': StorageError: Usuário ou senha PostgreSQL inválidos."),
        'fallback'
      )
    ).toBe('Usuário ou senha PostgreSQL inválidos.')
  })
})
