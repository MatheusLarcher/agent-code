# Colar link/caminho de arquivo no composer

## Objetivo

Hoje colar um arquivo de verdade (Ctrl+C num arquivo → Ctrl+V no chat) já funciona: vira
anexo com preview real (imagem) ou chip (demais tipos), com suporte a múltiplos de uma vez.
Falta cobrir quando o que é colado é só **texto** apontando pra um arquivo: um caminho local
("Copiar como caminho" do Explorer) ou uma URL http(s) de um arquivo. Esse texto deve virar o
mesmo tipo de anexo visual — sem sobrar duplicado como texto solto na caixa.

## Regra central: nunca ler bytes de arquivo grande

O fluxo atual de anexo manual (`FileAttachment`) lê o arquivo inteiro no renderer e manda por
IPC como base64 — por isso tem teto de 25 MB. Pra link/caminho colado isso não pode se repetir,
porque o objetivo explícito é suportar arquivo grande:

- **Caminho local existente**: nunca lê o conteúdo. Só confirma que existe (stat) e manda o
  **caminho original** pro LLM. Sem limite de tamanho.
- **URL http(s)**: main baixa (streaming) pra uma pasta de anexos e manda o **caminho do
  arquivo baixado**. Tem um teto (para em 200 MB, timeout 60s) só pra não travar baixando algo
  enorme sem querer.
- **Imagem** (por caminho local ou link): única exceção que ainda lê bytes — precisa virar
  `data:` URL pra aparecer como preview de verdade e pra ir como bloco de imagem pro modelo
  (visão), igual já acontece hoje com imagem colada como blob. Usa o limite já existente de
  50 MB do `fileReadBytes`.

## Detecção no paste

Em `Composer.tsx`, o `onPaste` atual só trata `clipboardData.items` do tipo `file` (mantém
como está, intocado). Novo: quando o clipboard não tem arquivo mas tem texto, divide em linhas
e testa cada uma:

- **Parece caminho** — Windows (`C:\...`), UNC (`\\servidor\...`) ou POSIX (`/...`).
- **Parece URL de arquivo** — começa com `http(s)://` e termina (ignorando querystring) numa
  extensão conhecida (pdf, doc(x), xls(x), ppt(x), txt, md, csv, zip, rar, 7z, png, jpg/jpeg,
  gif, webp, e outras do mesmo grupo já usado pelo chip). URL sem extensão reconhecida não é
  tratada como arquivo — evita falso positivo em link de página comum.

Só entra nesse fluxo (e só faz `preventDefault`) quando pelo menos uma linha bate um dos dois
padrões — colar um parágrafo normal continua exatamente como hoje, sem round-trip nenhum.
Linhas candidatas disparam uma resolução no main (stat do caminho, ou download da URL). Linhas
que não batem nenhum padrão, ou que o main não conseguiu resolver (arquivo sumiu, link caiu),
voltam/continuam como texto normal na caixa — nada é descartado silenciosamente; erro de
resolução gera um toast.

Múltiplas linhas resolvem em paralelo; cada uma que resolve vira seu próprio anexo (mesmo
comportamento hoje de multi-anexo).

## Novo tipo: anexo por referência

`FileAttachment` continua igual (carrega base64, usado só pelo fluxo manual/blob já existente).
Novo tipo em `src/shared/ipc.ts`:

```ts
export interface FileRefAttachment {
  name: string
  path: string       // caminho absoluto já em disco (local ou baixado)
  mediaType: string
  size: number
}
```

Lista de extensões conhecidas + mime-por-extensão vira um helper novo e compartilhado
(`src/shared/mime.ts`), usado tanto no renderer (decidir se uma URL "parece" arquivo) quanto no
main (decidir mediaType/isImage ao resolver) — fonte única, evita a lista divergir entre os
dois lados.

## IPC novo (main)

- `app:resolve-pasted-path` — recebe a string candidata; faz `stat`; devolve `{ok:false}` se
  não existir ou não for arquivo, senão `{ok:true, name, path, mediaType, size, isImage}`.
- `app:download-pasted-url` — recebe `{url, convId}`; valida protocolo http(s); baixa em
  streaming (mesmo padrão do `download()` já usado em `androidEnv.ts`) pra
  `<userData>/attachments/<convId>/`, abortando se passar de 200 MB ou 60s; devolve o mesmo
  formato ou `{ok:false, error}`.

Nenhum dos dois lê/retorna bytes — só metadados + caminho. Pra imagem, o renderer faz uma
chamada extra no IPC `fileReadBytes` (já existente) pra obter o base64 e montar um
`ImageAttachment` normal, reaproveitando o pipeline de preview/visão que já existe hoje.

## Composer: estado e render

Novo estado `fileRefs: FileRefAttachment[]`, ao lado de `images`/`files`. Renderiza com o mesmo
visual de chip de `files` (ícone/nome/tamanho, botão de remover) — mecanismo de origem
diferente, aparência idêntica. Enquanto uma linha está sendo resolvida (stat local é quase
instantâneo, mas download pode levar alguns segundos), o composer mostra "Resolvendo N
arquivo(s)…" e bloqueia o envio — mesmo padrão do bloqueio já existente quando falta pasta de
projeto.

## Envio

`onSend`/`sendMessage`/`dispatch` (Composer → ChatPanel → App.tsx) ganham um 4º parâmetro
`fileRefs`. `window.api.sendMessage` idem. No handler `agent:send` (main/index.ts), os
`fileRefs` entram na mesma nota de "arquivos anexados" que já existe hoje — só que sem passar
por `saveAttachments` (já estão em disco, seja o caminho original do usuário ou o download): a
lista de referências vira bullets `- nome: caminho` junto dos que vieram de `files`.

Na bolha do usuário e na fila (`QueuedMessage`, retry de falha) os `fileRefs` entram junto dos
`files` só para exibição (nome + tamanho), igual já acontece hoje.

## Validação

- Colar 1 caminho local existente (não-imagem) → vira chip, texto não sobra na caixa, mensagem
  enviada referencia o caminho original (sem cópia em disco).
- Colar 1 caminho de imagem local → preview de imagem real, some da caixa.
- Colar 1 link http(s) de PDF → baixa, chip aparece, mensagem referencia o caminho baixado.
- Colar link de imagem → preview de imagem real (baixa e lê bytes).
- Colar bloco com 3 linhas (2 caminhos válidos + 1 texto qualquer) → 2 chips + a linha de texto
  continua na caixa.
- Colar um link/caminho inválido (arquivo apagado, URL 404) → volta como texto, com toast de
  erro.
- Colar texto normal (nenhuma linha parece caminho/URL) → comportamento idêntico ao atual.
- Enviar durante resolução em andamento → bloqueado com aviso, some assim que resolve.
- Arquivo grande (>25 MB) por caminho local → funciona sem limite, confirmando o objetivo
  original.
