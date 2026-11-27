import { describe, expect, it } from 'vitest'
import type { PermissionRequest } from '@shared/ipc'
import { clearPermissions, currentPermissions, dropPermission, enqueuePermission, updatePermission } from './permissionQueue'

const req = (id: string): PermissionRequest => ({ id, toolName: 'Edit', input: {} }) as unknown as PermissionRequest

describe('permissionQueue', () => {
  it('dois pedidos seguidos: responder o 1º mostra o 2º (antes ele sumia sem resposta)', () => {
    let q = enqueuePermission({}, 'c1', req('a'))
    q = enqueuePermission(q, 'c1', req('b'))
    expect(currentPermissions(q).c1.id).toBe('a')
    q = dropPermission(q, 'c1', 'a')
    expect(currentPermissions(q).c1.id).toBe('b')
    q = dropPermission(q, 'c1', 'b')
    expect(q).toEqual({})
  })

  it('o 2º pode expirar antes do 1º; o mesmo id não entra duas vezes', () => {
    let q = enqueuePermission(enqueuePermission({}, 'c1', req('a')), 'c1', req('b'))
    q = enqueuePermission(q, 'c1', req('a'))
    expect(q.c1.map((r) => r.id)).toEqual(['a', 'b'])
    q = dropPermission(q, 'c1', 'b')
    expect(currentPermissions(q).c1.id).toBe('a')
    expect(dropPermission(q, 'c1', 'zzz')).toBe(q)
  })

  it('limpar e atualizar valem só para a conversa certa', () => {
    let q = enqueuePermission(enqueuePermission({}, 'c1', req('a')), 'c2', req('x'))
    q = updatePermission(q, 'c2', 'x', (r) => ({ ...r, deadline: 5 }) as PermissionRequest)
    expect((currentPermissions(q).c2 as { deadline?: number }).deadline).toBe(5)
    q = clearPermissions(q, 'c1')
    expect(Object.keys(q)).toEqual(['c2'])
  })
})
