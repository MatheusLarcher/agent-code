---
id: "causa-1-falha-conta-como-sucesso"
tipo: "nota"
titulo: "Causa 1: falha no meio do turno conta como sucesso"
etapa: "diagnostico"
links: ["req-identificar-erro","req-segundo-item-so-no-fim-real"]
fonte: "src/renderer/src/App.tsx:1178"
rev: 2
---
**Onde:** `src/renderer/src/App.tsx:1178-1179`

```ts
const receivedResponse = inflightRef.current[cid]?.responseReceived === true
const failed = (!receivedResponse || (e.kind === 'error' && e.retryable === false)) && shouldRecoverTerminal(...)
```

`responseReceived` liga no **primeiro** `assistant-text` do turno (`App.tsx:1126-1128`), e quase todo turno agêntico fala algo antes da 1ª ferramenta ("Vou ler o arquivo…"). Daí em diante, **qualquer** fim com erro (`result.is_error`, `error` do fim do stream) é tratado como turno concluído:
- o cartão de recuperação é limpo (`App.tsx:1280`);
- o **próximo item da fila é despachado** (`App.tsx:1295` em diante).

Agravante: o CLI entrega o erro de API como uma mensagem *assistant* sintética ("API Error: 529 …", com `assistant.error` preenchido). O main não filtra isso (`src/main/agentSession.ts:2835-2851`) e emite como `assistant-text`, o que liga `responseReceived` mesmo num turno em que o modelo não respondeu nada.

Origem da heurística: o comentário em `App.tsx:1175-1177` diz que "alguns provedores" entregam a resposta inteira e só então marcam o frame terminal como erro, **sem dizer qual**. Ela entrou no commit `561ab4e` (27/08, "save pending changes", junto com o trabalho de servidor local tipo Ollama) **sem teste próprio**. O caso legítimo (resposta completa + erro só no fim) tem de continuar contando como concluído, mas pelo desfecho classificado no main, não por "já apareceu texto". E precisa ganhar um teste.

**Casa com o relato:** "só pode entrar o segundo item da fila quando a tarefa terminar de fato".
