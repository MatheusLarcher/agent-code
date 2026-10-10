---
id: "sug-watchdog-stream-cli"
tipo: "sugestao"
titulo: "Ligar o watchdog de stream do próprio CLI"
etapa: "deteccao"
status: "aceita"
links: ["causa-2-silencio-so-avisa","dec-silencio-aborta"]
fonte: "node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe"
rev: 2
---
**O quê:** passar `CLAUDE_ENABLE_STREAM_WATCHDOG=1` no `env` com que o app sobe o CLI (`agentSession.ts:1165-1223`, nos três ramos: conta Claude, GPT e Ollama).

**O que achei:** o binário do CLI empacotado (SDK 0.3.289) tem um watchdog para stream de API pendurado. Ele aborta o pedido com "Stream idle timeout - no chunks received" e **retenta dentro do mesmo turno** (sai como `system/api_retry`). A chave é tri-estado (`D.triBool()`): sem a variável, quem decide é o próprio CLI, provavelmente por flag remota, e não dá para saber daqui se está ligado para este usuário. Existe também `CLAUDE_STREAM_IDLE_TIMEOUT_MS` para o prazo. Já `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS` está documentado no `sdk.d.ts:3598`.

**Ganho concreto:** a causa mais comum de "Claude parado sem erro" (stream que não fecha) passa a ser resolvida **dentro do turno**, em segundos ou poucos minutos, sem abortar nem mandar "continue". Isso evita reler o contexto inteiro e evita reexecutar ferramenta. O aborto do app ([[Silêncio além do limite aborta o turno e vira falha retomável]]) fica como rede de segurança para o resto (ferramenta MCP pendurada, CLI travado).

**Custo:** uma linha, mais um teste que confere a variável no `env`.

**Risco:** a variável **não está documentada**: achei no binário, não na doc pública. Pode mudar de nome numa versão futura. Nesse caso, ela é ignorada e voltamos ao comportamento de hoje, sem quebrar nada. Vale conferir no log ([[Log de sessão: JSONL diário no main + stderr do CLI]]) se aparecem `api_retry` com `stream_idle_timeout` depois de ligar.
