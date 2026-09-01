# Memórias autoritativas e documentação do projeto em cada dispatch

## Objetivo

Garantir que cada mensagem enviada ao LLM use o estado atual das memórias persistentes e receba a documentação do projeto correspondente ao `cwd` daquela conversa.

## Memórias persistentes

O catálogo completo de memórias continuará no system prompt inicial. Antes de cada dispatch, o Agent Code calculará uma assinatura baseada no conteúdo de todos os Markdown da pasta de memórias, incluindo subpastas.

Quando qualquer arquivo for criado, alterado ou removido, a mensagem receberá um bloco `[PERSISTENT_MEMORY_UPDATE]` com uma substituição autoritativa completa. Catálogos anteriores serão descartados semanticamente; nunca serão combinados.

Quando nada mudar, o catálogo não será repetido. Isso mantém as memórias disponíveis pelo histórico da sessão sem duplicá-las a cada turno.

A assinatura por conteúdo evita perder alterações que mantenham o mesmo tamanho e timestamp. Symlinks, entradas ocultas, arquivos binários e arquivos ilegíveis continuam fora do catálogo.

## Documentação do projeto atual

Cada dispatch reconstruirá um bloco autoritativo a partir de `<cwd>/docs`.

### Markdown na raiz de `docs`

Todo arquivo Markdown diretamente em `docs/` será enviado com:

- caminho relativo;
- conteúdo integral;
- marcador explícito caso fique ilegível durante a leitura.

O conteúdo da raiz terá um teto de segurança agregado de 8 MiB por dispatch. Ao atingir o teto, os arquivos restantes continuam listados com um marcador explícito, evitando travar o processo principal ou exceder o corpo máximo da requisição.

### Conteúdo das subpastas

A varredura continuará recursiva. Para arquivos Markdown abaixo da raiz serão enviados apenas:

- caminho relativo;
- cabeçalhos Markdown, ignorando conteúdo dentro de blocos de código;
- marcadores quando a leitura dos cabeçalhos for limitada ou falhar.

Para arquivos não Markdown serão enviados apenas caminho e tipo (`image`, `pdf`, `json`, `yaml`, `text` ou extensão).

Diretórios aparecem na árvore. Symlinks nunca serão seguidos.

## Formato e autoridade

O bloco passa a se chamar `[PROJECT_DOCS_CONTEXT]` e declara que representa o estado completo de `docs/` no momento daquele dispatch. Cada bloco novo substitui semanticamente os anteriores.

A ordem será determinística por caminho. O contexto enviado ao LLM em cada mensagem seguirá:

1. carimbo de data/hora e origem;
2. documentação atual do projeto;
3. atualização de memória, quando houver;
4. atualização de skills, quando houver;
5. texto do usuário.

Se `docs/` não existir, não for diretório ou estiver inacessível, o bloco ainda será enviado com o motivo, sem bloquear a conversa.

## Segurança e isolamento

A raiz sempre será `join(cwd, "docs")`. A varredura não seguirá links simbólicos nem aceitará caminhos que escapem dessa raiz. Uma conversa nunca reutilizará documentação de outro projeto.

Falhas de leitura serão representadas por código sanitizado (`ENOENT`, `EACCES` etc.), sem expor conteúdo de erro arbitrário no prompt.

## Componentes afetados

- `src/main/memoryIndex.ts`: assinatura de conteúdo das memórias.
- `src/main/projectOutline.ts`: contexto híbrido — Markdown raiz completo, subpastas por cabeçalho.
- `src/main/agentSession.ts`: reconstrução e ordenação dos blocos antes de cada dispatch.
- testes de memória, documentação e sessão do agente.

## Critérios de aceite

1. alteração de memória com mesmo tamanho e timestamp produz atualização autoritativa;
2. memória inalterada não é duplicada;
3. criação e remoção de memória substituem o catálogo completo;
4. todo `docs/*.md` dentro do teto agregado chega integralmente em cada dispatch, e excedentes recebem marcador;
5. Markdown em subpasta envia cabeçalhos, mas não o corpo;
6. arquivos não Markdown enviam apenas caminho e tipo;
7. mudança em `docs/*.md` aparece na mensagem seguinte;
8. troca de conversa/projeto usa somente o `cwd` correto;
9. symlinks não são seguidos;
10. pasta ausente ou ilegível gera marcador seguro e não bloqueia;
11. suíte completa, typecheck e build terminam sem erros.

## Custo consciente

O conteúdo integral de `docs/*.md` será repetido em cada dispatch por decisão explícita. Isso aumenta o contexto e o consumo de tokens conforme a conversa cresce. As subpastas permanecem resumidas por cabeçalhos para limitar esse crescimento.