# Vigia — o agente que questiona em paralelo

## Contexto

O agente principal executa o que foi pedido. Quando a **premissa** do pedido está
errada — uma medida que só o usuário conhece, uma intenção ambígua, uma restrição
não declarada — o erro só aparece na entrega, e aí o trabalho inteiro é refeito.
Foi o que motivou este subprojeto: num pedido de peça 3D, errar o diâmetro do
eixo inutiliza a peça, e quem modelou é o pior revisor da própria premissa.

O `critico` do registro de tarefas **não** resolve isso: ele confere entregáveis
contra critérios de aceite, e antes da primeira linha de código não há entregável
nenhum. É outro papel.

## Objetivo

Uma **segunda sessão**, barata, rodando em paralelo à conversa, com uma pergunta
só:

> alguma premissa deste trabalho depende de algo que **só o usuário** sabe e não
> foi confirmado?

Quando a resposta é sim, ela avisa o usuário. **Não interrompe o agente
principal**, não fala com ele, não decide nada. O botão de parar continua sendo
do usuário.

## Fora de escopo

- Revisar código, sugerir melhoria, opinar sobre estilo ou arquitetura. Um
  observador que fala sobre tudo é um observador que o usuário silencia em uma
  semana — a mesma lição do watchdog de travamento, cujo limiar precisou de dois
  níveis para não virar falso positivo.
- Ler o repositório. O vigia roda **sem ferramentas**: se a dúvida pode ser
  respondida lendo o projeto, não é uma dúvida para o usuário.
- Parar, cancelar ou dirigir o turno em andamento.
- Rodar como subagente da sessão principal (ver "Por que não é subagente").

## Por que não é subagente

Um subagente devolve a resposta **para o agente principal** e morre no fim do
turno. Isso cria um segundo dono da decisão — exatamente o que o usuário não
quer — e amarra o observador ao ciclo de vida de quem ele observa. O vigia é uma
sessão própria no main, alimentada pelo tee de eventos que já existe
(`emit` em `index.ts`, o mesmo ponto que abastece a ponte do celular e a
allowlist de download), e a saída dele vai **para a UI**, nunca para o modelo.

## Quando dispara

Uma análise **por turno do usuário**, no máximo. O gatilho é o primeiro destes,
depois da mensagem do usuário:

1. `VIGIA_CALL_TRIGGER` (3) chamadas de ferramenta acumuladas — é quando o agente
   já revelou como interpretou o pedido; ou
2. o `result` do turno, se ele terminou antes disso.

Antes das primeiras ações não há o que julgar (só o pedido); depois da entrega
o aviso chega tarde demais para o caso barato de refazer.

**Guardas** (todos em `vigiaPrompt.ts`, puros e testáveis):

- **Cooldown** de `VIGIA_COOLDOWN_MS` (60 s) por conversa.
- Só roda se o turno começou com uma **mensagem do usuário** (retomada de sessão
  e turno de recuperação não contam).
- **Dedupe por conteúdo**: o mesmo alerta (hash do texto normalizado) não é
  mostrado duas vezes na mesma conversa. Sem isso, uma premissa não resolvida
  vira o mesmo aviso em todo turno.
- **Digest capado**: 2000 caracteres da mensagem do usuário, até
  `VIGIA_MAX_CALLS` (12) chamadas, 200 caracteres por chamada. O custo não pode
  crescer com o tamanho da conversa.

## A chamada

`query()` avulso do Agent SDK, no molde do `visionRelay`: `tools: []`,
`maxTurns: 1`, `includePartialMessages: false`, modelo da config
(`vigia.model`, default `claude-sonnet-5`). Sem MCP, sem preset `claude_code`,
sem `settingSources` — o vigia não é um agente do projeto, é um leitor.

Entrada: o digest (pedido + ações). Saída: **uma linha**.

```
OK
ALERTA: <uma frase — a dúvida, na forma de pergunta ao usuário>
```

`parseVigiaVerdict` aceita as duas formas, ignora cercas de código e devolve
`null` para qualquer coisa que não case (falha fechada: silêncio, não alerta
inventado).

Falha de rede/SDK **degrada em silêncio** — o vigia nunca pode derrubar ou
atrasar a conversa que observa.

## O que o vigia vê, e o que não vê

Vê: o texto do usuário e a lista de ações (`nome da ferramenta` + detalhe curto,
o mesmo `describeCall` conceitual do mapa do projeto). Não vê: conteúdo de
arquivo, diffs completos, imagens, segredos do cofre. O digest é montado a
partir dos `ChatEvent` que já atravessam o tee.

## Saída: canal próprio, não `ChatEvent`

O alerta **não** entra no fluxo de `ChatEvent`. Dois motivos:

1. O cliente do celular (`smartfone-remote/www/app.js`) tem um conjunto
   `STATE_ONLY` e um `push` final: um `kind` desconhecido engordaria a lista de
   mensagens a cada ocorrência, invisível e acumulando.
2. O alerta é para o **usuário**, e um evento no stream é, por construção, algo
   que também vai para o histórico que o modelo relê.

Canal novo: `Channels.vigiaAlert` (`vigia:alert`), main → renderer,
`VigiaAlertMsg { convId, id, text, at }`.

## Interface

Um **chip** no `ChatPanel`, entre o histórico e o composer, no mesmo lugar e
molde do chip de pergunta pendente (`.pending-question-chip`), em âmbar:

> ⚠ O vigia levantou uma dúvida — toque para ver

Clicar expande o texto no próprio chip, com duas ações:

- **Dispensar** — some (estado do renderer, não persiste).
- **Perguntar ao agente** — enfileira o texto como mensagem do usuário pelo
  caminho normal de envio. Não interrompe o turno; entra na fila como qualquer
  mensagem enviada com o agente ocupado.

Não é modal, não rouba foco, não pausa nada.

## Configuração

`AppConfig.vigia = { enabled: boolean, model: string }`, com merge aninhado em
`config.ts` (igual a `openai`/`ollama`). Default **ligado**, modelo
`claude-sonnet-5` — o estado inicial já tem que servir, e o toggle existe para
desligar. Em **Configurações → Geral**: o interruptor e o seletor de modelo
(reusa a lista de modelos Claude).

Custo: uma chamada curta e sem ferramentas por turno, num modelo mais barato que
o da conversa. Consome a mesma assinatura Claude — por isso o teto por turno, o
cooldown e o digest capado são parte do contrato, não afinação.

## Componentes afetados

| Arquivo | Mudança |
|---|---|
| `src/shared/ipc.ts` | `VigiaConfig`, `AppConfig.vigia`, `DEFAULT_CONFIG`, `VigiaAlertMsg`, `Channels.vigiaAlert` |
| `src/shared/api.ts` | `onVigiaAlert` |
| `src/preload/index.ts` | ponte do canal |
| `src/main/config.ts` | merge aninhado de `vigia` |
| `src/main/vigia/vigiaPrompt.ts` | **puro**: digest, prompt, parse do veredito, hash do dedupe |
| `src/main/vigia/vigia.ts` | `Vigia`: buffer por conversa, gatilho, cooldown, dedupe, chamada |
| `src/main/index.ts` | instancia, alimenta no tee (`emit`) e no `agentSend`, envia o alerta |
| `src/renderer/src/App.tsx` | estado `vigiaAlerts` por conversa, listener, dispensar, perguntar |
| `src/renderer/src/components/VigiaChip.tsx` | o chip |
| `src/renderer/src/components/ChatPanel.tsx` | renderiza o chip |
| `src/renderer/src/styles.css` | `.vigia-chip*` |
| `src/renderer/src/ui/SettingsModal.tsx` | toggle + modelo em Geral |

## Testes

`vigiaPrompt.test.ts` (puro): digest respeita os tetos e preserva a ordem;
`parseVigiaVerdict` aceita `OK`/`ALERTA:`/cercado em crase e recusa lixo; hash
estável e insensível a espaço/caixa.

`vigia.test.ts` (`query` do SDK mockado): dispara uma vez por turno no 3º
tool-use; dispara no `result` se o turno foi curto; **não** dispara sem mensagem
do usuário; respeita o cooldown; desligado na config não chama o SDK; alerta
repetido é suprimido; falha do SDK não lança e não emite.

## Critérios de aceite

1. Conversa com premissa ambígua gera **um** alerta, e o agente principal segue
   trabalhando sem nenhuma interrupção.
2. Conversa trivial (pedido claro) não gera alerta nenhum.
3. Desligar na config para de chamar o modelo — verificável pela ausência de
   chamada ao SDK.
4. `npm run typecheck`, `npm test` e `npm run build` verdes.
