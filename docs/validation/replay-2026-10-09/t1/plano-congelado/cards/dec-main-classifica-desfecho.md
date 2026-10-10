---
id: "dec-main-classifica-desfecho"
tipo: "decisao"
titulo: "O main classifica o desfecho de cada turno"
etapa: "deteccao"
status: "aceita"
links: ["req-identificar-erro","causa-1-falha-conta-como-sucesso","causa-4-cli-sai-codigo-zero"]
fonte: "node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:5727"
rev: 4
---
**O quê:** os eventos terminais (`result` e `error` em `src/shared/ipc.ts:99`) passam a levar `outcome: 'concluido' | 'falhou' | 'interrompido'` e `reason` (curto, estável, ex.: `api_error`, `overloaded`, `sem_resposta`, `processo_encerrado`, `limite_uso`, `auth`, `contexto_cheio`). Quem decide é o **main**, que vê a mensagem crua do SDK. O renderer só obedece.

**Regras** (doc do SDK: "subtype success carrega o texto final — ou, com is_error true, o texto do erro quando o turno acabou num erro de API"):
- `result` com `subtype: 'success'`, `is_error: false` e `terminal_reason` ausente ou `completed` → `concluido`;
- `is_error: true`, subtypes `error_*` ou `terminal_reason` ∈ {`api_error`, `model_error`, `aborted_streaming`, `aborted_tools`, `turn_setup_failed`, `malformed_tool_use_exhausted`, `prompt_too_long`…} → `falhou`;
- Stop do usuário → `interrompido` (nunca dispara retentativa);
- mensagem *assistant* com `error` preenchido (a sintética "API Error: …") **não** vira `assistant-text`: vira linha de erro/status e alimenta o `reason`;
- `system/api_retry` conta como sinal de vida (`markActivity`) e emite um status para o aviso ("API instável, tentativa 3/10");
- fim do iterador fora do `dispose` (código 0) → `queryDied = true` + `error` com `outcome: 'falhou'`, `reason: 'processo_encerrado'` ([[Causa 4: CLI que sai com código 0 deixa sessão zumbi]]).

**Preservar:** o caso de provedor que entrega a resposta inteira e só então marca erro, que é o motivo da heurística `responseReceived` ([[Causa 1: falha no meio do turno conta como sucesso]]). O código não diz qual provedor é, e ela entrou sem teste (commit `561ab4e`, na época do servidor local tipo Ollama).
- Sinal candidato: `result.stop_reason === 'end_turn'` sem ferramenta pendente. Atenção: no streaming, o `stop_reason` das mensagens *assistant* vem `null` (`sdk.d.ts`, doc do `SDKAssistantMessage`); só o do `result` vale.
- **Reproduzir o caso antes de escolher o sinal** (Ollama local e GPT/proxy) e escrever o teste dele. Se não der para reproduzir, a regra vale só para o provedor em que foi visto, nunca para Claude.

**Por quê no main:** é o único lugar que vê `terminal_reason`, `assistant.error`, `stop_reason` e a saída do processo. Duplicar a heurística no renderer foi o que gerou a Causa 1.
