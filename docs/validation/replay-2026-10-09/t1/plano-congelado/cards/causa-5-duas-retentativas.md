---
id: "causa-5-duas-retentativas"
tipo: "nota"
titulo: "Causa 5: duas retentativas que não se conversam"
etapa: "diagnostico"
links: ["req-retomar-de-onde-parou","req-fila-nunca-se-perde"]
fonte: "src/main/agentSession.ts:2666"
rev: 1
---
**Main** (`src/main/agentSession.ts:2666-2678` + `src/main/persistence/sqliteRepository.ts:1786`, idem Postgres): num `result` com `is_error` ou cota esgotada, `requeueAgentInput` devolve o item a `pending` com `available_at = agora`, e o `drainPersistedInputs` **reempurra na hora a mensagem ORIGINAL** para o CLI. Não há espera, e `attempt_count` sobe sem que ninguém confira um teto. Com limite de uso, vira um laço de tentativas que falham.

**Renderer** (`src/renderer/src/App.tsx:1243-1261` e `2753-2815`): ao mesmo tempo, agenda em 60 s um turno novo "Continue exatamente de onde parou…" (até 5 vezes).

Efeitos:
- o pedido original roda de novo inteiro (o modelo recebe o mesmo prompt duas vezes no histórico) **e** depois ainda chega a continuação;
- os eventos do reenvio trazem o `turnId` do turno que o renderer já deu por encerrado. `turnIdentity.owner` os trata como `stale`, ou os **adota** no turno em voo seguinte (`central/turnIdentity.ts:80-84`): tela e main saem de sincronia;
- depois de reiniciar o app, `recoverAgentInput` volta o item `processing` a `pending` e ele roda de novo (o original, inteiro) antes da próxima mensagem do usuário.

Precisa de **um dono só** para a retentativa.
