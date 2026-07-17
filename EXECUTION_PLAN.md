# EXECUTION_PLAN — Pergunta/permissão do agente chegando no celular (sessão remota)

## Prompt original (verbatim)
> Quando o LLM manda um questionário para me responder, no computador ele aparece corretamente,
> eu respondo direitinho e funciona. Só que quando eu tô pela sessão remota, pelo aplicativo
> Android, esse questionário não aparece para mim, para eu poder responder. Eu preciso conseguir
> responder o questionário. Você consegue fazer para mim?

## Causa raiz (confirmada por investigação)
Em `src/main/index.ts`, ao criar cada `AgentSession`, os **eventos de chat** (`ChatEvent`) já são
retransmitidos pro celular (`remote.broadcast(convId, event)`), mas o **pedido de
permissão/pergunta** (`(req) => send(Channels.agentPermissionRequest, { convId, req })`, linha
~575) só vai pro **IPC do desktop** — nunca chega na ponte remota. O celular nunca fica sabendo
que existe uma pergunta pendente.

## Regra de segurança (memória do projeto)
Este Claude Code roda DENTRO do próprio app agent-code. **NUNCA** reiniciar/relançar o Electron
(`npm run dev`/`npm start`, `_electron.launch`, matar `electron.exe`) — derrubaria a sessão real
do usuário sem como reabrir sozinho. Toda validação é por `npm run typecheck`/`vitest`/`npm run
build` (não abrem janela). Ver memória `nao-fechar-electron-do-proprio-agent-code`.

## Desenho (segue o padrão já usado por "recuperação de turno", que já funciona no celular)
Em vez de um canal SSE novo, o pedido pendente vira um campo a mais no **snapshot da conversa**
que o renderer já publica pro bridge (`RemoteConversation.permission`), do mesmo jeito que
`recovery` já funciona hoje. O celular consulta via `/api/state` (já é chamado depois de eventos
relevantes) e manda a resposta por uma rota nova (`POST /api/permission-respond`), que cai no
mesmíssimo `AgentSession.resolvePermission` que o desktop já usa.

```
Agente pede permissão → AgentSession → main (onAsk) → App.tsx (permissions state)
   → publishRemoteState (novo campo `permission` por conversa) → RemoteServer.setState
   → celular via /api/state (+ gatilho extra em 'tool-use'/'result' pra buscar rápido)
   → celular renderiza modal (Allow/Deny OU pergunta com opções, igual ao desktop)
   → POST /api/permission-respond {convId, id, behavior, answers?}
   → RemoteServer → onPermissionResponse → sessions.get(convId).resolvePermission(res)
```

## Tarefas
- [x] **T1 — Tipos compartilhados**: `shared/ipc.ts` — `RemoteConversation.permission?:
  PermissionRequest` (reaproveita o tipo que já existe, sem duplicar).
- [x] **T2 — Wiring do main**: `RemoteServerDeps.onPermissionResponse` + construção do
  `RemoteServer` em `index.ts`. Correção de desenho: NÃO resolve direto em `sessions.get(convId)`
  (deixaria o modal do desktop preso, já que ele limpa seu estado local só quando é ele quem
  responde) — em vez disso reenvia pro renderer via canal novo `remote:permission-response`
  (`onRemotePermissionResponse`), igual o `onRecoveryAction` já faz.
- [x] **T3 — RemoteServer**: rota `POST /api/permission-respond` (valida campos, chama o dep).
  Testes em `remoteServer.test.ts` (200 com dep chamado corretamente; 400 sem campos; 401 sem
  token — já coberto pelo guard existente).
- [x] **T4 — Publicar do renderer**: `App.tsx` — `permission: permissions[c.id]` no
  `publishRemoteState`; `permissions` adicionado nas dependências do `useEffect` de publish.
  Extraído `respondToPermission(convId, res)` de `respond`/`answerQuestion` (parametrizado, não
  mais fixo em `activeId`) + novo listener `onRemotePermissionResponse` que chama a mesma função
  quando o celular responde primeiro, pra fechar o modal do desktop também. Typecheck OK.
- [x] **T5 — Cliente do celular** (`smartfone-remote/www/`): modal `#perm-modal` novo em
  `index.html`, estilos `.perm-*`/`.modal-overlay` em `styles.css`, `renderPermission()` em
  `app.js` (allow/deny simples OU pergunta com opções + "Outro" livre, igual ao
  `QuestionModal`/`PermissionModal` do desktop; contador regressivo por `deadline`; POST em
  `/api/permission-respond`; gatilho extra de `fetchState()` em eventos `tool-use`; re-render ao
  trocar de conversa pra não misturar pergunta de uma conversa com outra).
- [x] **T6 — Validação**: `npm run typecheck` OK, `npx vitest run` 230/230 OK (mock de
  `window.api` no App.test.tsx ganhou `onRemotePermissionResponse`), `npm run build` OK,
  `node --check app.js` OK. `docs/ARQUITETURA.md` e `docs/REFERENCIA.md` atualizados.

## Fluxos a validar
- Pergunta simples (Allow/Deny de ferramenta) chega no celular e a resposta volta pro agente.
- `AskUserQuestion` (múltiplas perguntas, single/multi-select, "Outro" livre texto) funciona igual
  ao desktop.
- Countdown/deadline aparece e expira do mesmo jeito.
- Responder pelo **desktop** enquanto o celular também está com o modal aberto → celular fecha o
  modal sozinho (a pergunta já não existe mais no snapshot).
- Trocar de conversa no celular não mistura pergunta de uma conversa com outra.
