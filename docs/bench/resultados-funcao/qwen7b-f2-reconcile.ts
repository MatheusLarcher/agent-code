export interface Registro {
  id: string
  updatedAt: number
  messages?: unknown[]
}

export function reconcile<T extends Registro>(local: T[], remoto: T[]): T[] {
  const resultado: T[] = []
  const idsLocais = new Set<string>()
  const idsRemotos = new Set<string>()

  // Adiciona registros de local que não estão em remoto
  for (const item of local) {
    if (!item.id || item.id === '') continue
    idsLocais.add(item.id)
    resultado.push(item)
  }

  // Mescla registros de local e remoto, resolvendo conflitos
  for (const item of remoto) {
    if (!item.id || item.id === '') continue
    idsRemotos.add(item.id)

    const index = resultado.findIndex(r => r.id === item.id)
    if (index === -1) {
      // Registro de remoto não está em local, adiciona-o
      resultado.push(item)
    } else {
      // Registro de remoto está em local, resolve conflito
      const registroLocal = resultado[index]
      if (item.updatedAt > registroLocal.updatedAt ||
          (item.updatedAt === registroLocal.updatedAt && item.messages?.length ?? 0 >= registroLocal.messages?.length ?? 0)) {
        resultado[index] = item
      }
    }
  }

  // Adiciona registros de remoto que não estão em local
  for (const id of idsRemotos) {
    if (!idsLocais.has(id)) {
      const item = remoto.find(r => r.id === id)!
      resultado.push(item)
    }
  }

  return resultado
}
