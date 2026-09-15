# PO do quadro — failover Claude → GPT Luna

## Decisão

O Product Owner (PO) do quadro tenta sempre **Claude primeiro**. Se a chamada
observadora Claude não puder ser concluída por indisponibilidade de plano/uso ou
por autenticação/autorização Claude, o PO tenta uma única vez **GPT Luna**
(`gpt-5.6-luna`). A segunda tentativa usa a mesma preparação de runtime e a
mesma rota GPT/Codex já usada por uma sessão GPT normal: Agent SDK/CLI para o
proxy local, tradução no proxy e request Responses Lite ao upstream Codex.

O PO não ganha um seletor de provider. Claude continua sendo a política fixa da
primeira tentativa; Luna é a política fixa do fallback. A seleção de modelo da
sessão principal, inclusive o último GPT usado e o fallback normal para Astra,
não altera esse contrato do PO.

Isto não é um adaptador HTTP genérico. Claude conserva a chamada direta atual
para o Agent SDK. GPT Luna conserva o seu runtime externo normal: proxy loopback,
OAuth ChatGPT, cabeçalhos/IDs Codex, `ANTHROPIC_BASE_URL` apontado ao proxy e
`CLAUDE_CONFIG_DIR` externo isolado. O formato Anthropic recebido pelo proxy e a
tradução para Responses/Codex são detalhes exclusivos da rota GPT já existente,
não dados que a rota Claude reutiliza ou tenta interpretar.

## Estado atual que a mudança fecha

Hoje `po.ts` chama `askObserver()` diretamente com `query({ prompt, model,
tools: [], maxTurns: 1 })`; só aceita modelos Claude, não recebe o `cwd` da
sessão nem a configuração/runtime do provider. Já a sessão principal conhece
como iniciar GPT: identifica o modelo OpenAI, exige login ChatGPT, inicia o
proxy e isola a configuração Claude antes de chamar o Agent SDK. O wrapper de
failover principal também não serve ao PO: ele troca pelo último GPT ou por
Astra e preserva um transcript de conversa, enquanto o PO é uma chamada
observadora de uma rodada e deve cair especificamente para Luna.

A implementação deve extrair e reutilizar a preparação GPT existente, sem
copiar uma segunda versão de proxy, login, variáveis de ambiente ou isolamento
de config dentro de `po.ts`.

## Objetivo e fora de escopo

O objetivo é fazer o PO ainda auditar e atualizar o quadro para uma conta sem
Claude utilizável, quando o login GPT/Codex normal estiver disponível, mantendo
o formato textual fechado do PO (`CONCLUIR`, `TITULO`, `NOVA`, `OK`) e as
proteções que descartam operações inválidas ou inseguras.

Fica fora de escopo:

- fallback GPT → Claude, cascata de modelos, ping-pong, retry temporizado ou
  seleção baseada em custo, latência, conteúdo ou qualidade;
- alterar o provider/modelo de uma conversa normal, o fallback de sessões
  principais ou a seleção visível no composer;
- converter token, sessão, cabeçalho, objeto de cliente ou resposta bruta de um
  provider para o outro;
- chamar o upstream Codex diretamente pelo PO, ignorando o proxy e a tradução
  que o fluxo GPT normal já aplica;
- permitir que um erro do observador derrube o turno principal ou faça uma
  escrita parcial no quadro;
- expor credenciais, IDs de conta, headers ou corpos brutos de provider.

## Pedido lógico e fronteira de provider

A entrada compartilhada será um **pedido lógico do observador**, criado uma vez
quando o `result` do turno dispara a auditoria. Ela contém:

- prompt já montado pelo PO e o modelo Claude primário configurado;
- `conversationId`, `cwd` e o `projectId`/cartões que o PO já consultou para
  aquela conversa;
- uma correlação nova da auditoria;
- um snapshot imutável das opções relevantes da sessão: configurações de
  `board.po`, disponibilidade/configuração de provider necessária para iniciar
  o runtime e opções que a sessão GPT normal propaga ao Agent SDK.

O `cwd` vem de `sessionCwds.get(conversationId)`/das opções que iniciaram a
sessão, e nunca de `process.cwd()` no instante do fallback. O PO deve receber
esse valor explicitamente da entrada em `index.ts`, da mesma forma que o tee do
quadro já recebe `opts.cwd`. Ele não deve inferi-lo por conversa nem reabrir um
projeto diferente depois do `result`.

O snapshot congela a decisão de roteamento; mudanças de configurações enquanto
o observador está em curso não podem trocar Luna, permissões ou opções entre as
duas tentativas. Ele não armazena nem serializa o OAuth token: a rota GPT o
obtém pelo mecanismo normal de login no momento em que sua preparação é
executada.

A fronteira comum é somente:

```ts
type ObserverAttempt =
  | { provider: "claude" | "gpt-luna"; state: "completed"; text: string }
  | {
      provider: "claude" | "gpt-luna";
      state: "not-started" | "failed";
      reason: SafeProviderReason;
    };
```

Ela não é um payload de rede. A tentativa Claude recebe apenas seus parâmetros
Claude. A tentativa GPT recebe a intenção do observador e o snapshot e então
monta seu próprio runtime/payload pelo caminho GPT normal. Nenhuma recebe URL,
credencial, cabeçalho, ID de sessão, bloco de resposta ou objeto de cliente da
outra.

## Sequência determinística

1. Ao terminar um turno normalmente, `po.observe` aguarda a fila do quadro,
   captura os cartões do projeto/conversa e cria o pedido lógico uma vez.
2. O orquestrador chama `runClaudeObserver` com o mesmo observador atual:
   ferramentas vazias, no máximo um turno e o modelo de `config.board.po`.
3. Se Claude retorna texto, o PO o interpreta e aplica no máximo as seis
   operações atuais. GPT Luna não é consultado.
4. Se Claude retorna uma falha elegível, o orquestrador registra somente o
   diagnóstico seguro, inicia `runGptLunaObserver` uma vez e fornece-lhe o
   pedido lógico original.
5. `runGptLunaObserver` prepara o runtime GPT normal com modelo fixo
   `gpt-5.6-luna`: valida login ChatGPT, inicia/obtém o proxy, usa o ambiente
   externo isolado e chama o Agent SDK para o proxy. O proxy mantém a conversão
   Messages/SSE → Codex Responses e o contrato de resposta normal.
6. Se Luna retorna texto, o mesmo parser fechado do PO processa o texto e só
   então aplica as operações no quadro. Se Luna não puder iniciar ou falhar, o
   PO encerra sem mutação; não volta para Claude nem tenta um terceiro provider.

Não existe escrita no quadro entre as tentativas. O parser e a persistência só
recebem o texto da tentativa que completou. Isso torna impossível duplicar uma
operação do PO por uma transição de provider.

## Gatilho fechado de fallback

A classificação é positiva e por tipo/campo estruturado, nunca por substring de
mensagem. A tentativa Claude é elegível apenas se o adaptador a reduzir a uma
destas razões seguras:

| Razão | Condição necessária |
| --- | --- |
| `claude_plan` | terminal/erro Claude reconhecido como `usageExhausted` ou negação explícita de plano/entitlement antes de existir texto utilizável do observador |
| `claude_auth` | ausência, expiração ou recusa de credencial Claude reconhecida pelo cliente/SDK |
| `claude_authorization` | autorização Claude explicitamente negada pelo cliente/SDK |

A existência de texto utilizável termina a auditoria Claude normalmente; não há
fallback depois disso. Embora o observador tenha `tools: []` e não escreva no
quadro, esse limite evita que um resultado parcial de provider seja descartado e
substituído silenciosamente.

Não são elegíveis: HTTP ou exceção sem classificação acima (inclusive
`401`/`403` ambíguo), falha de rede, timeout, 429, 5xx, erro de protocolo/proxy,
validação do prompt, cancelamento, recusa do modelo, exceção do parser, banco
indisponível ou falha após texto utilizável. Eles preservam o comportamento
atual do PO: degradar em silêncio, sem lançar no turno principal e sem escrever
no quadro.

O login GPT não é testado antes de Claude, pois isso quebraria a prioridade
Claude. Depois de um gatilho elegível, a ausência de login GPT ou falha para
iniciar seu proxy é o resultado final seguro da auditoria; não reclassifica o
caso nem retorna a Claude.

## Diagnóstico, eventos e UX

O PO hoje engole seus erros; para tornar o fallback auditável, o orquestrador
produzirá um evento/metadado interno com:

- `requestedProvider: "claude"`;
- `actualProvider: "claude" | "gpt-luna"` para a tentativa que completou ou
  começou;
- `fallbackReason` limitado às três razões da tabela, somente após escolher
  Luna;
- a correlação comum às duas tentativas.

A ordem é fixa: `claude-started`; `claude-unavailable`; `po-provider-switch`;
`gpt-luna-started`; eventos/resultados GPT. Se Luna não puder iniciar, o último
é o erro seguro GPT. Depois de `gpt-luna-started`, nenhum evento Claude tardio
pode alterar o desfecho. Eventos de saída que o caminho GPT normal já emite não
recebem novo formato ou nova semântica.

O renderer recebe um diagnóstico transitório e seguro quando a troca de fato
começar: “Claude indisponível para o PO; continuando com GPT Luna.” Ele deve
usar o sistema de toast no canto, empilhado, fechável, com entrada/saída e
expiração automática — nunca uma faixa estática. Não é sucesso: é um aviso. O
toast só aparece depois de `gpt-luna-started`; se a preparação GPT falhar, um
toast de erro descreve a indisponibilidade GPT em termos seguros. Mensagens não
incluem token, conteúdo de `Authorization`, headers, request/response brutos ou
ID de conta.

## Componentes previstos

| Área existente | Mudança de responsabilidade |
| --- | --- |
| `src/main/index.ts` | Passar `cwd` e snapshot de opções de sessão ao PO no envio/tee; publicar o diagnóstico seguro para a UI. |
| `src/main/po/po.ts` | Orquestrar as duas tentativas, aplicar a classificação fechada, manter o parser/persistência depois de uma única resposta completa e continuar degradando sem derrubar o turno. |
| `src/main/observerQuery.ts` | Separar a chamada Claude do contrato de tentativa e receber runtime explicitamente, em vez de esconder todo contexto de sessão. |
| `src/main/agentSession.ts` e preparação GPT reutilizável | Expor a inicialização já usada por sessão GPT — login, proxy, ambiente e config externa isolada — para o observador, sem duplicá-la. |
| `src/main/codexProxy.ts` | Sem rota nova: continuar sendo o único tradutor Messages/SSE → Codex Responses para Luna. |
| `src/shared/ipc.ts`, preload/API e renderer | Tipar/transportar diagnóstico sem segredo e mostrar os toasts de aviso/erro. |
| `src/main/config.ts` e Settings | Preservar `board.po.model` Claude como primário; não adicionar seletor GPT/Luna. |

## Matriz de testes

### Orquestrador e classificação

| Cenário | Claude | GPT Luna | Resultado esperado |
| --- | --- | --- | --- |
| Claude conclui | texto válido | não chamado | parser/persistência Claude; sem switch |
| `usageExhausted` Claude sem texto | falha `claude_plan` | conclui | uma chamada Luna; parser recebe só texto Luna |
| Auth Claude reconhecida | falha `claude_auth` | conclui | uma chamada Luna; razão segura correta |
| Autorização Claude reconhecida | falha `claude_authorization` | conclui | uma chamada Luna; razão segura correta |
| 429, timeout, rede, 5xx ou 401/403 ambíguo | falha não elegível | não chamado | degradação atual; sem switch |
| Claude retorna texto e parser rejeita | completa | não chamado | nenhuma escrita insegura; sem fallback |
| Cancelamento | cancelado | não chamado | nenhuma escrita; sem fallback |
| GPT sem login após gatilho | elegível | não inicia | erro seguro GPT; sem escrita e sem retorno Claude |
| Proxy/GPT falha após gatilho | elegível | falha | erro seguro GPT; sem terceira tentativa |
| Luna conclui e parser aceita | elegível | texto válido | no máximo seis operações normais do PO, uma única vez |

### Integração de rota e estado

1. O pedido GPT Luna recebe o mesmo `cwd`, `conversationId`, `projectId`, cartões
e correlação do pedido Claude; uma mudança posterior no config não muda a
segunda tentativa.
2. A inicialização Luna usa `gpt-5.6-luna`, login ChatGPT, proxy loopback,
`ANTHROPIC_BASE_URL` e `CLAUDE_CONFIG_DIR` isolado exatamente como a sessão GPT
normal; nenhuma credencial Claude persistida aparece no ambiente externo.
3. O proxy recebe o formato Messages/SSE normal da rota GPT e emite o request
Codex Responses/Lite normal; a tentativa Claude não recebe configuração OAuth,
proxy ou campos Codex.
4. A configuração de provider/modelo de uma conversa GPT normal e o fallback
existente da sessão principal permanecem inalterados.
5. A sequência de eventos é observável e determinística; toast de aviso só
ocorre após Luna começar, e toast de erro ocorre se ela não iniciar/falhar.
6. O `cwd` é indispensável: duas conversas em diretórios distintos, completando
em ordem inversa, atualizam somente os cartões do respectivo `projectId`.

## Critérios de aceite

1. Claude é sempre a primeira tentativa do PO.
2. Só `usageExhausted`/plano, autenticação ou autorização Claude
   estruturadamente reconhecidos e sem texto utilizável acionam uma única
   tentativa Luna.
3. Luna é sempre `gpt-5.6-luna` e percorre a rota GPT/Codex normal, com seu
   próprio login, proxy, formato e config externa isolada.
4. `cwd`, snapshot, IDs, cartões e correlação são preservados; nenhum segredo ou
   estado de transporte atravessa a fronteira de provider.
5. Não há escrita antes de uma resposta completa aceita pelo parser, nem mais de
   duas tentativas; falhas não elegíveis e falha Luna degradam sem derrubar o
   turno principal.
6. O fallback é diagnosticável por evento seguro e toast de aviso/erro; não
   produz sucesso falso nem detalhes sensíveis.
7. A matriz de testes passa e o fluxo GPT normal, o fallback normal de sessões e
   a UI sem fallback não regressam.

## Auto-revisão da especificação

- **Luna não é Astra:** o modelo do PO foi fechado em `gpt-5.6-luna`, sem
  herdar o fallback/último modelo da sessão principal.
- **Plano tem sinal concreto:** `usageExhausted` entra explicitamente em
  `claude_plan`; toda outra falha fica fora até que o adaptador a classifique.
- **Prioridade preservada:** o login GPT é verificado somente depois da falha
  Claude elegível, portanto sua ausência não antecipa nem troca a tentativa
  inicial.
- **Sem contradição de formato:** GPT continua recebendo Messages no proxy e o
  proxy continua convertendo para Codex; o que não cruza a fronteira é estado,
  segredo ou payload de uma tentativa já construída pelo outro provider.
- **Sem duplicação de efeito:** o PO não interpreta nem persiste nada antes de
  haver uma única resposta completa da rota vencedora.
- **Diagnóstico não vira UI estática:** switch efetivo é aviso por toast;
  impossibilidade de iniciar Luna é erro por toast; ambos usam conteúdo seguro.
- **Escopo contido:** não adiciona seletor, rota OpenAI direta, cascata ou mudança
  no fluxo GPT normal.
