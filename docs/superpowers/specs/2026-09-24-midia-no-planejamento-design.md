# Mídia no planejamento — design

Data: 2026-09-24 · Status: aprovado pelo usuário (implementação liberada junto)

## Objetivo

A Tela de Planejamento passa a aceitar imagens e qualquer outro arquivo (PDF, vídeo, áudio, planilha,
documento…) **dentro do plano**. O Agent Manager sabe o tipo de cada arquivo e o usa; o handoff para o
agente principal leva as mídias como **caminho absoluto + tipo**, e o agente principal é avisado de
onde elas estão.

Hoje o chat do Manager já aceita anexos (é o mesmo `ChatPanel`), mas o anexo morre na conversa: não
entra no plano, no canvas, no `plan_read` nem no handoff. É isso que muda.

## Decisões

- **Anexo em qualquer card + card próprio de mídia** (escolha do usuário). Todo card pode ter
  `anexos`; o tipo novo `midia` é um card cujo conteúdo é o(s) arquivo(s).
- **Caminho, não bytes, no handoff.** O prompt leva o caminho absoluto e o tipo; o agente abre com
  `Read` (imagem e PDF o `Read` mostra de verdade). O Manager, no `plan_read` de um card, recebe
  também as imagens como bloco de imagem.
- **Fora do escopo:** mandar mídia automaticamente a cada mensagem do chat do Manager; embutir
  imagens no PDF exportado do flow (só os nomes); apagar arquivo órfão sozinho.

## Contratos

### Compartilhado — `src/shared/planningMedia.ts` (puro)

```ts
export const MEDIA_DIR = 'midia'
export const MAX_MEDIA_BYTES = 200 * 1024 * 1024        // importação
export const MAX_MEDIA_PREVIEW_BYTES = 20 * 1024 * 1024 // planning:readMedia
export const MAX_ANEXOS_POR_CARD = 20
export type MediaKind = 'imagem' | 'pdf' | 'video' | 'audio' | 'planilha' | 'documento'
  | 'apresentacao' | 'texto' | 'compactado' | 'outro'
export const MEDIA_KIND_LABEL: Record<MediaKind, string>   // "Imagem", "PDF", "Vídeo"…
export function mediaKindOf(nameOrPath: string): MediaKind  // pela extensão
export function isValidMediaName(name: unknown): name is string
export function mediaFileName(original: string, prefix: string): string
export interface PlanMediaDto { name: string; path: string; kind: MediaKind; size: number; mediaType: string }
```

- Nome de mídia válido: `^[a-z0-9][a-z0-9_-]*(\.[a-z0-9]{1,10})?$`, até 120 caracteres — sem
  separador, sem `..`, sem maiúscula. `mediaFileName` tira acento, põe em minúsculas, troca o resto
  por `-`, preserva a extensão e prefixa `prefix` (6 hex): `a1b2c3-tela-de-login.png`.
- `src/shared/mime.ts` ganha extensões de vídeo (mp4, webm, mov, mkv, avi) e áudio (mp3, wav, ogg,
  m4a, flac) em `mimeForExt`.

### Modelo — `planningModel.ts`

- `CARD_TYPES` ganha `'midia'`. `PlanCard.anexos?: string[]`.
- Frontmatter: chave `anexos` (JSON), gravada **só quando não vazia** — cards antigos continuam
  byte a byte iguais.
- `validateCard`: cada anexo `isValidMediaName`, sem repetição, no máximo `MAX_ANEXOS_POR_CARD`;
  tipo `midia` exige pelo menos um anexo.

### Store — `src/main/planning/planningMedia.ts` (novo; `planningStore.ts` já está no limite de 500 linhas)

- `importMedia(projectCwd, slug, src)` com `src = { name, data: Buffer } | { path, name? }` →
  `PlanMediaDto`. A origem tem de ser arquivo comum e ≤ `MAX_MEDIA_BYTES`. Grava em
  `<plano>/midia/<mediaFileName>` de forma atômica (tmp + rename), **registrando a gravação como
  própria** — o vigia compara bytes; `recordOwnWrite` passa a aceitar `Uint8Array` (ou registro por
  hash).
- `listMedia(projectCwd, slug)` → `PlanMediaDto[]` (só arquivos comuns com nome válido).
- `readMedia(projectCwd, slug, name)` → `{ mediaType, base64, size }`, recusando acima de
  `MAX_MEDIA_PREVIEW_BYTES`.
- Todo caminho passa por `resolvePlanPath` (exportado do store): nome inválido, symlink para fora ou
  plano inexistente são recusados.
- `midia/` **não** é ignorada pelo vigia: mídia nova vinda de fora recarrega a tela.

### IPC

- `OpenedPlanningDto.media: PlanMediaDto[]` (preenchido no `planning:open` com `listMedia`);
  `PlanningCardDto.anexos?: string[]`; o `CardSchema` do IPC aceita `anexos` e o tipo `midia`.
- `planning:importMedia` `{ projectCwd, slug, files: Array<{ name, data } | { path }> }` →
  `PlanningResult<{ media: PlanMediaDto[] }>`. Arquivo arrastado do Explorer vai **por caminho**
  (`webUtils.getPathForFile` no preload); imagem colada da área de transferência vai em base64.
- `planning:readMedia` `{ projectCwd, slug, name }` → `PlanningResult<{ mediaType, base64, size }>`.
- Zod na fronteira, nenhuma exceção atravessa (padrão `register` do `planningIpc`).

### Agent Manager

- `plan_read`: cada card lista os anexos (`[Imagem] nome — <caminho absoluto>`); o plano inteiro
  termina com a seção "Mídias do plano" (inclui órfãs, marcadas "sem card"). Com `card_id`, as
  imagens png/jpeg/gif/webp do card vão também como blocos `image` (até 4, cada ≤ 5 MB; as que ficam
  de fora são citadas no texto).
- `plan_card_create`/`plan_card_update` aceitam `anexos` (nomes que existem em `midia/`; `[]` limpa).
- `plan_midia_importar { caminho, card_id?, expected_rev? }`: copia um arquivo (anexo do chat,
  arquivo do projeto, `_sandbox`) para `midia/`; com `card_id` (exige `expected_rev`) já anexa.
  Devolve nome, tipo e caminho absoluto.
- `buildPlanningHint`: parágrafo sobre mídia — onde fica, como abrir cada tipo, `plan_midia_importar`
  para pôr no plano o que o usuário colou no chat.
- `handoffAppendBlock`: cita `midia/` e manda abrir imagem/PDF com `Read`.

### Tela

- `cardTypes.tsx`: tipo `midia` (rótulo "Mídia", cor e ícone próprios; `--pl-midia` no CSS).
- `CardNode`: imagem anexada vira miniatura (data URL via `planning:readMedia`, cache por nome);
  outros tipos viram etiqueta com ícone + tipo + nome. A altura do nó continua limitada.
- `CardEditor` + `cardDraft`: seção "Anexos" — miniatura/ícone, tipo, abrir (no app padrão do
  sistema), remover do card, "Anexar arquivo…".
- `PlanningCanvas`: soltar arquivo(s) do Explorer ou colar imagem (Ctrl+V, fora de campo de texto):
  em área vazia cria card `midia` na posição/coluna do drop; em cima de um card, anexa a ele.
- Erros e sucesso em **toast** (padrão global do usuário).

### Handoff

- `buildDraftHandoff`: anexos em cada card (tipo + caminho absoluto) e seção final "Mídias do plano
  (abra com Read)".
- `managerHandoffRequest`: exige incluir no prompt os caminhos absolutos + tipo das mídias
  relevantes.
- `handoffReadiness`: aviso (não bloqueio) para anexo que não existe em `midia/`.
- `flowPdf`: lista os nomes dos anexos no card.

## Testes

Round-trip do card com/sem anexos (card antigo idêntico); validação de `midia`; `mediaKindOf` e
`mediaFileName`; `importMedia` (nome saneado, colisão, symlink, limite, gravação própria);
`planning:importMedia`/`readMedia` com payload inválido; texto e blocos de imagem do `plan_read`;
`plan_midia_importar`; rascunho de handoff com caminhos; aviso de anexo sumido; drop/paste do canvas.

## Execução

Quatro tarefas no registro: **base** (modelo, store, IPC, tipos) primeiro; depois **Manager**,
**tela** e **handoff/PDF** em paralelo, cada uma com escopo de escrita disjunto.
