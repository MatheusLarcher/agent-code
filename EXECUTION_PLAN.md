# EXECUTION_PLAN — Trocar modelo/esforço pelo APK + idioma do ditado

## Prompt original do usuário (verbatim)

> No APK, permita trocar o modelo LLM e também permita trocar o esforço. quando a mensagem.
> Eu vou te trocar isso. парода. O idioma é melhorado no chat do APK? Tenta ajustar isso também.

Interpretação: no cliente remoto do celular (APK / `smartfone-remote`), permitir trocar o
**modelo LLM** e o **esforço de raciocínio** da conversa (como já dá no PC); e melhorar o
**idioma da transcrição de voz** do ditado (saiu "парода" — texto em russo — no meio da fala
em português).

## Tarefas

- [x] Tarefa 1 — Backend da troca modelo/esforço (PC):
  - `shared/ipc.ts`: `RemoteConversation.model/effort`, `RemoteStatePayload.models/modelEffort/effortLabels`,
    `RemoteSetModelMsg`, canal `remoteSetModel`.
  - `remote/remoteServer.ts`: rota POST `/api/set-model` (convId + model/effort) → dep `onSetModel`.
  - `main/index.ts`: wiring `onSetModel` → `send(Channels.remoteSetModel, …)`.
  - `preload/index.ts` + `shared/api.ts`: `onRemoteSetModel`.
  - `App.tsx`: publicar `model`/`effort` por conversa + catálogo de modelos/esforços no snapshot;
    handler `onRemoteSetModel` reusando `changeModel`/`changeEffort` (com trava de busy).
  - Fluxos a validar: typecheck/testes; POST na rota muda o modelo/esforço no PC.
- [x] Tarefa 2 — UI no celular (www/):
  - `index.html`/`styles.css`/`app.js`: barra acima do composer com 2 seletores nativos
    (modelo + esforço), preenchidos do `/api/state`; troca → POST `/api/set-model`;
    esforço some p/ modelo sem suporte (Ollama); desabilitado enquanto a conversa está busy.
  - Fluxos a validar (cliente web /app, mesmo código do APK): abrir → seletores mostram o
    modelo/esforço atuais; trocar modelo → PC reflete; trocar esforço → PC reflete; trocar de
    conversa → seletores acompanham; conversa busy → seletor travado.
- [x] Tarefa 3 — Idioma da transcrição (ditado):
  - `main/openai.ts`: além de `language: 'pt'`, adicionar `prompt` de contexto pt-BR para o
    gpt-4o-transcribe não alucinar outro idioma em trechos curtos/ruidosos (ex.: "парода").
  - Fluxos a validar: typecheck; revisão do request (campo prompt presente).
- [x] Tarefa 4 — Validação de runtime ponta a ponta + docs:
  - Rodar o app do PC, ligar a ponte, abrir `/app` no navegador (mesmo bundle do APK),
    exercitar os fluxos da Tarefa 2 de verdade; F5; estado sem conversas.
  - Atualizar `docs/REFERENCIA.md`/`ARQUITETURA.md`.
