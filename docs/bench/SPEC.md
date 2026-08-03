# Tarefa do benchmark — Arquivar conversas

Implemente, no projeto agent-code, o recurso **arquivar conversas**. A mesma
especificação é dada a todos os modelos avaliados. Nenhum deles vê os testes de
aceitação nem a solução dos outros.

## 1. Módulo novo: `src/shared/archive.ts`

Exporte exatamente estas funções (tipos genéricos sobre qualquer objeto com
`id: string`, `updatedAt: number` e `archived?: boolean`):

```ts
export interface Archivable { id: string; updatedAt: number; archived?: boolean }

/** true apenas quando `archived === true`. */
export function isArchived(c: Archivable): boolean

/** Separa a lista em visíveis e arquivadas, preservando a ordem original nas duas. */
export function partitionArchived<T extends Archivable>(list: T[]): { visible: T[]; archived: T[] }

/** Nova lista com o item `id` marcado/desmarcado. Imutável: não altera a lista
 *  nem os objetos recebidos. `id` inexistente → lista equivalente, sem mudanças. */
export function setArchived<T extends Archivable>(list: T[], id: string, archived: boolean): T[]

/** Id da primeira conversa NÃO arquivada da lista, ou null se não houver. */
export function firstVisibleId<T extends Archivable>(list: T[]): string | null

/** Ao arquivar `id`, qual conversa deve ficar ativa: a próxima não arquivada
 *  DEPOIS dele na lista; se não houver, a não arquivada mais próxima ANTES dele;
 *  se não sobrar nenhuma, null. Recebe a lista como está ANTES de arquivar. */
export function nextActiveAfterArchive<T extends Archivable>(list: T[], id: string): string | null
```

## 2. Tipo

`Conversation` (`src/renderer/src/types.ts`) ganha `archived?: boolean`, documentado
no estilo dos outros campos.

## 3. Sidebar (`src/renderer/src/components/Sidebar.tsx`)

- Nova prop obrigatória: `onArchive: (id: string, archived: boolean) => void`.
- Cada linha de conversa ganha um botão de ação com
  `title="Arquivar"` (ou `title="Desarquivar"`, quando já arquivada) ao lado do
  botão de excluir, que chama `onArchive(id, true|false)`.
- Conversa arquivada **não** aparece nas listas de projeto nem em "Chats".
- No fim da barra, uma seção `Arquivadas (n)` — some quando `n === 0` — que
  expande/recolhe ao clique e lista as arquivadas, cada uma com o botão
  "Desarquivar".
- A busca por prompt ignora conversas arquivadas.

## 4. Persistência

O campo `archived` tem que sobreviver ao ciclo salvar → carregar do
`src/main/projectStore.ts`, e conversa arquivada nunca pode ser escolhida como
conversa ativa inicial (use `firstVisibleId`).

## 5. Regras do projeto

- `npm run typecheck` e `npm test` (suíte existente) têm que continuar verdes.
- Siga o estilo do repositório: comentários em português explicando o *porquê*,
  arquivos abaixo de 500 linhas, nada de dependência nova.
