# Arquivo real grande (>25MB) colado/arrastado no composer

## Objetivo

Colar (Ctrl+V), arrastar, ou anexar pelo botão de clipe um arquivo de verdade (não texto/link)
maior que 25MB não faz nada visível hoje — sem chip, sem erro. Causa: `addFiles()` em
`Composer.tsx` filtra `f.size <= MAX_FILE_BYTES` antes de converter pra base64; o que passa do
teto é descartado do array silenciosamente, sem passar por nenhum outro branch.

## Regra central

A mudança só entra em ação **acima de 25MB**. Arquivo pequeno continua idêntico ao
comportamento atual (lido e mandado como base64) — zero risco de regressão no que já funciona.

Para um arquivo grande:

1. Tenta obter o caminho real em disco via `webUtils.getPathForFile(file)` (API nativa do
   Electron, disponível desde a v32; o projeto usa v42). Exposta no preload como
   `window.api.getPathForFile(file)` — chamada síncrona, sem round-trip de IPC.
2. **Sem caminho** (raro — ex. um blob gerado em memória, sem lastro em disco): descarta com
   toast de erro explicando o motivo, em vez de sumir silenciosamente.
3. **Com caminho**: chama o IPC `resolvePastedPath` já existente (reaproveitado integralmente
   da feature de colar caminho/link — só faz `stat`, nunca lê o conteúdo) para confirmar que o
   arquivo existe e obter `mediaType`/`isImage`.
   - **Não-imagem** → vira `FileRefAttachment` (chip), sem limite de tamanho.
   - **Imagem até 50MB**: lê via `readFileBytes` (teto já existente) e mostra preview real.
   - **Imagem acima de 50MB**: vira chip genérico com o caminho (sem tentar ler bytes, sem
     preview) — não tenta forçar uma imagem gigante pra memória do renderer.

Isso corrige de graça um bug adjacente: hoje uma imagem colada como blob não tem limite nenhum
(`FileReader.readAsDataURL` tenta ler o arquivo inteiro não importa o tamanho); com caminho
resolvível, passa a respeitar o mesmo teto de 50MB do `readFileBytes`.

## Pontos de entrada afetados

`addFiles()` é compartilhada pelos 3 pontos que hoje colam/arrastam/anexam um `File` real:
colar (Ctrl+V) um arquivo copiado no Explorer, arrastar-e-soltar, e o botão de anexo manual
(input file). A correção em `addFiles()` cobre os três de uma vez, sem duplicar lógica.

## Novo IPC

- `app:get-path-for-file` **não é necessário como IPC** — `webUtils.getPathForFile` roda
  síncrono no próprio preload (que tem acesso a módulos do Electron mesmo com
  `contextIsolation: true`), então é exposto direto via `contextBridge` como uma função
  síncrona, sem round-trip pro main.

## Reuso da proteção contra vazamento entre conversas

A checagem que o code-review da feature anterior introduziu (`pastedConvId` comparado contra
`convIdRef.current` antes de cada `setState`, pra um Composer que não remonta por conversa) é
extraída para uma função compartilhada e usada também neste novo fluxo — evita reintroduzir o
mesmo bug de vazamento por duplicação de código, já que resolver um arquivo grande (stat +
leitura de imagem) pode levar um tempo perceptível, tempo o bastante pro usuário trocar de
conversa no meio.

## Validação

- Colar um arquivo real de verdade >25MB (não-imagem) → chip aparece, sem erro de tamanho.
- Colar uma imagem real >25MB e <50MB → preview de imagem real aparece.
- Colar uma imagem real >50MB → chip genérico (sem preview), sem travar/sem erro.
- Colar/arrastar/anexar (os 3 pontos de entrada) um arquivo >25MB → mesmo resultado nos três.
- Arquivo pequeno (≤25MB), qualquer tipo → comportamento idêntico ao atual, sem mudança visível.
- Enviar a mensagem → o LLM recebe o caminho original do arquivo (nunca uma cópia), com o aviso
  de "arquivo anexado pelo usuário", igual ao fluxo de caminho colado como texto.
- Trocar de conversa enquanto um arquivo grande ainda está resolvendo → o chip/preview não
  aparece na conversa errada (mesma proteção já validada na feature anterior).
