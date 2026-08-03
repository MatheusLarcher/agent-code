export interface Registro {
  id: string;
  updatedAt: number;
  messages?: unknown[];
}

export function reconcile<T extends Registro>(local: T[], remoto: T[]): T[] {
  const result: T[] = [];
  const seenIds = new Set<string>();

  // Processar registros locais
  for (const item of local) {
    if (!item.id || item.id === '') continue;
    seenIds.add(item.id);
    result.push(item);
  }

  // Processar registros remotos
  for (const item of remoto) {
    if (!item.id || item.id === '') continue;
    if (seenIds.has(item.id)) {
      const existingItem = result.find(r => r.id === item.id)!;
      if (item.updatedAt > existingItem.updatedAt ||
          (item.updatedAt === existingItem.updatedAt && 
           (item.messages?.length ?? 0) > (existingItem.messages?.length ?? 0))) {
        const index = result.indexOf(existingItem);
        result[index] = item;
      }
    } else {
      seenIds.add(item.id);
      result.push(item);
    }
  }

  return result;
}
