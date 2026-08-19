# Mockups WireMD compactos dentro da conversa

## Objetivo

Adicionar ao Agent-Code a tool nativa `render_ui_mockup`, executada localmente e
renderizada dentro do chat. Quando houver intenção explícita de visualizar ou alterar uma
interface, o preview deve substituir caixas ASCII, código de exemplo e descrições longas.
Pedidos apenas textuais, conceituais ou de implementação não devem acionar a tool.

O primeiro rascunho da funcionalidade já presente no worktree comprovou a integração básica,
mas falhou no uso real porque o modelo gerou `<row>` e `<col>`. A validação corretamente
rejeitou HTML, porém o agente recebeu apenas um erro genérico, repetiu a mesma entrada três
vezes e nunca aprendeu que WireMD 0.6.1 representa colunas com `::: columns-N`.

## Escopo

- Uma tool MCP em processo, sem CLI, subprocesso, servidor local ou segunda IA.
- `@eclectic-ai/wiremd` fixado em `0.6.1`, usando `parse()` e `renderToHTML()`.
- Preview estático, compacto, seguro e persistente no chat desktop e no cliente remoto.
- Edição posterior com o mesmo `id`, `version` incrementada e reaproveitamento do `source`.
- Uma única correção permitida após erro de parser ou validação.
- Testes unitários, integração do AgentSession, renderer, persistência e smoke test real.

Não fazem parte desta entrega um editor WireMD, exportação de arquivos, preview em navegador
externo, interação JavaScript dentro do mockup ou um framework genérico para outros artifacts.

## Dependência e runtime

O pacote deve permanecer como dependência de runtime com versão exata `0.6.1`; o lockfile
deve registrar `resolved` e `integrity`. O import principal é a primeira opção:

```ts
import { parse, renderToHTML } from '@eclectic-ai/wiremd'
```

Os subpaths `/parser` e `/renderer` só serão usados se o build real reprovar o import
principal. O runtime local é Node 22.20.0. Embora WireMD aceite Node 18+, Electron 42 exige
Node 22.12+, portanto o projeto declarará `engines.node: ">=22.12.0"` para refletir o mínimo
efetivo da aplicação.

## Arquitetura

### Renderer desacoplado

Uma unidade pequena concentra a biblioteca:

```ts
interface UiMockupRenderer {
  render(source: string): Promise<{ html: string; source: string }>
}

class WireMdMockupRenderer implements UiMockupRenderer
```

`WireMdMockupRenderer` valida a entrada, chama `parse()`, valida a AST, aplica os limites de
compactação, chama `renderToHTML(ast, { style: 'clean' })` e entrega o HTML ao sanitizador.
O registro MCP depende apenas de `UiMockupRenderer`, permitindo substituir WireMD sem alterar
AgentSession, IPC ou React.

### Tool e controlador por conversa

`render_ui_mockup` recebe somente:

```ts
{
  title: string
  source: string
  viewport?: 'desktop' | 'mobile'
}
```

O schema aplica título de 1 a 80 caracteres, source de 1 a 2.500 caracteres e viewport
`desktop` por padrão. Um controlador criado por `AgentSession` mantém:

- artifacts conhecidos, indexados pelo título normalizado;
- último `id` e `version` de cada título;
- contagem de falhas do turno atual;
- método `beginTurn()` chamado ao receber uma nova mensagem do usuário.

Uma chamada com título novo cria `id` e `version: 1`. Uma chamada com o mesmo título é uma
revisão, mantém o `id` e incrementa `version`. Ao reiniciar uma conversa, o renderer envia no
`StartAgentOptions` a versão mais recente de cada artifact persistido para semear o controlador.
O prompt interno também recebe o título e o source ativos para que uma sessão sem `resume`
consiga editar o mockup anterior. Pedidos explícitos de várias telas usam títulos distintos e
continuam limitados a três artifacts.

O evento estruturado enviado ao chat é:

```ts
{
  type: 'ui_mockup'
  id: string
  version: number
  title: string
  source: string
  html: string
  viewport: 'desktop' | 'mobile'
}
```

O resultado textual devolvido ao modelo contém `id`, `version`, `title`, `source` e viewport,
mas não replica o HTML/CSS grande no contexto do LLM. O evento IPC é o artifact estruturado
completo. O arquivo HTML redundante no cache não será criado.

### Decisão do agente

A mesma regra semântica ficará na descrição da tool e no system prompt:

```text
usar_tool = existe_intencao_visual
             E NAO existe_pedido_apenas_textual_ou_de_implementacao
```

O prompt incluirá exemplos positivos, negativos, prioridades e uma referência curta da
sintaxe WireMD 0.6.1. Em especial, colunas serão ensinadas com sintaxe real:

```wiremd
::: columns-3
### Fila
12 chamados

### SLA
((92%)){success}

### Equipe
8 atendentes
:::
```

O prompt proíbe `<row>`, `<col>`, JSX, HTML e blocos de código. Ao editar, o modelo deve
reutilizar exatamente o título e o source anterior, alterando apenas os elementos solicitados.

`mcp__wiremd__render_ui_mockup` será autoaprovada porque só transforma texto em HTML estático
local. A chamada e o tool-result não entram no feed como `ToolCard`; assim o source não fica
exposto ao expandir JSON e o preview permanece a resposta principal.

## Validação e compactação

Antes do parser, a entrada rejeita:

- tags HTML, incluindo `script`, `iframe`, `object` e `embed`;
- URLs `javascript:`, `vbscript:` e `data:text/html`;
- atributos de evento como `onclick=`;
- JSX/React, imports, funções JavaScript e blocos de código cercados por crases;
- source vazio ou acima de 2.500 caracteres.

Depois de `parse()`, a AST é validada e analisada. A tool rejeita mockups que excedam uma tela
por chamada, quatro seções, quatro colunas, oito blocos visuais, dezesseis controles ou dois
níveis de hierarquia. Pedidos grandes continuam válidos se o source representar somente a
tela inicial principal. Esses limites ficam em funções puras testáveis, sem depender apenas do
comportamento probabilístico do modelo.

## Sanitização e iframe

`renderToHTML()` devolve um documento completo. Ele não será aninhado dentro de outro
`<body>`. O fluxo será:

```text
WireMD source -> parse -> AST -> renderToHTML -> allowlist sanitizer
              -> documento com CSP fixa -> iframe sandboxado
```

`sanitize-html` 2.17.7, fixado como dependência de runtime, executará uma allowlist no processo
main; `@types/sanitize-html` 2.16.1 ficará em devDependencies. O sanitizador removerá scripts,
iframes, objects, embeds, forms ativos, handlers `on*`, URLs externas e protocolos perigosos.
Somente tags e atributos necessários ao HTML/SVG estático do WireMD serão mantidos. CSS com
`@import` ou `url()` será rejeitado. O documento final recebe CSP com `default-src 'none'`, sem
rede, scripts, navegação, formulários, pop-ups ou origem compartilhada.

O React usa um único `<iframe sandbox="" referrerPolicy="no-referrer" srcDoc={html}>`. Desktop
usa referência 1024 x 640 e mobile 390 x 760. O card limita a altura; excedentes rolam dentro
do próprio preview. O cliente `smartfone-remote` renderiza o mesmo artifact em iframe
sandboxado, em vez de descartar silenciosamente o evento.

Artifacts carregados do SQLite passam por validação estrutural e limites de tamanho antes de
chegar ao `srcDoc`. O HTML continua isolado mesmo se o histórico estiver corrompido.

## Erros e retry

`beginTurn()` zera o contador. Na primeira falha de validação, parser ou renderização, a tool:

1. registra detalhes técnicos no log;
2. devolve ao agente um erro curto com a causa segura e `retryAllowed: true`;
3. instrui a simplificar e corrigir a sintaxe apenas uma vez.

Na segunda falha, o controlador bloqueia novas tentativas naquele turno e devolve
`retryAllowed: false`. O prompt obriga a resposta final exata:

```text
Não consegui renderizar este mockup.
```

Chamadas adicionais no mesmo turno recebem o mesmo resultado final e nunca executam o parser.
Uma renderização bem-sucedida encerra o estado de retry. A mensagem técnica não aparece no
feed porque o ToolCard específico é ocultado.

## Persistência e fluxo de dados

1. O modelo chama a tool MCP em processo.
2. O controlador valida, renderiza, sanitiza e versiona.
3. `AgentSession` emite `ChatEvent.kind = 'ui-mockup'` no track principal.
4. Main encaminha por IPC e pela ponte LAN.
5. Desktop e celular exibem o iframe estático.
6. `Conversation.messages` persiste source, HTML sanitizado e metadados no SQLite por projeto.
7. Ao reconectar, as versões mais recentes semeiam o controlador e o prompt interno.

Artifacts emitidos por subagentes preservam `parentToolUseId` e não vazam para o feed
principal. A compactação de histórico mantém os artifacts, inclusive source e versão.

## Testes e verificação

### Unitários

- import principal, `parse()` e `renderToHTML({ style: 'clean' })` reais;
- validação de título, source, viewport, HTML, JavaScript, React e protocolos;
- limites estruturais de compactação;
- sanitização de script, handler, iframe, URL externa e CSS remoto;
- CSP e documento final sem HTML aninhado;
- primeira falha permite uma correção; segunda bloqueia; terceira não chama o renderer;
- mesmo título mantém `id` e incrementa versão; título diferente cria artifact novo.

### Integração

- MCP registrado com descrição e schema corretos;
- tool autoaprovada e sem modal;
- prompt contém regra visual, exceções, compactação, retry e sintaxe `::: columns-N`;
- evento completo chega ao reducer e não há ToolCard/source exposto;
- artifact persiste, restaura e semeia nova AgentSession;
- desktop e cliente remoto usam iframe sandboxado;
- casos de intenção visual, pergunta conceitual, código, edição e pedido grande ficam cobertos
  por testes das instruções/fixtures e pela simulação determinística do fluxo do SDK.

### Comandos finais

```powershell
npm run typecheck
npm test
npm run build
npm run windows-control:test
git diff --check
```

O repositório não possui script de lint nem configuração ESLint; isso será registrado como
limitação real, sem introduzir uma infraestrutura de lint alheia ao objetivo. O smoke test
manual deve abrir o app, pedir um dashboard visual, confirmar apenas um preview inline, editar
SLA/fila e verificar mesmo `id` com versão incrementada. Também deve confirmar que a
renderização funciona sem rede e sem segunda chamada de IA.
