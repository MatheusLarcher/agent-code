# Desafio de função — reconciliar duas listas de conversas

Implemente `src/shared/reconcile.ts` no projeto agent-code.

```ts
export interface Registro {
  id: string
  updatedAt: number
  /** Quanto do registro está preenchido; usado só para desempate. */
  messages?: unknown[]
}

/**
 * Junta `local` e `remoto` numa lista só, sem duplicar por `id`.
 */
export function reconcile<T extends Registro>(local: T[], remoto: T[]): T[]
```

## Regras

1. Um `id` aparece **uma vez só** no resultado.
2. Em conflito, vence o `updatedAt` **maior**.
3. Empate no `updatedAt`: vence quem tem **mais** itens em `messages`
   (`undefined` conta como zero).
4. Empate nos dois: vence o de **`local`**.
5. A ordem do resultado segue a **primeira aparição** de cada `id`, varrendo
   `local` inteiro e depois `remoto`.
6. Registro sem `id` (string vazia) é **descartado**.
7. Nenhuma das listas de entrada pode ser modificada, nem os objetos dentro delas.
8. Lista vazia dos dois lados → `[]`.

Estilo do projeto: TypeScript estrito, sem dependência nova, sem ponto e vírgula
no fim das linhas, comentário explicando o *porquê* das decisões não óbvias.
