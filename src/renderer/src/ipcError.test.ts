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

  it('remove metadados tipados da persistência e preserva o motivo seguro', () => {
    expect(
      ipcErrorMessage(
        new Error("Error invoking remote method 'conversations:upsert': StorageError: " +
          '[agent-code-storage-error:REVISION_CONFLICT:fatal] A conversa foi alterada por outra gravação.'),
        'fallback'
      )
    ).toBe('A conversa foi alterada por outra gravação.')
  })
})
