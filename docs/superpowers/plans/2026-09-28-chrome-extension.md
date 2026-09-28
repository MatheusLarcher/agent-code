# Plano — extensão Chrome local (contrato compartilhado)

Spec: `docs/superpowers/specs/2026-09-28-chrome-extension-design.md`.

## Contrato fixo (todas as tarefas obedecem)

- Portas: `CHROME_BRIDGE_PORTS = [47831, 47832, 47833, 47834, 47835]` (servidor usa a primeira livre; extensão tenta em ordem).
- ID da extensão: derivado da `key` do `manifest.json`; constante `CHROME_EXTENSION_ID` exportada em `src/main/chromeBridge/extensionId.ts` (T1).
- `config.js` gerado na pasta instalada (script clássico, carregado via `importScripts('config.js')`):
  `self.AGENT_CODE_CONFIG = { ports: [...], token: '<hex>' }`
- Versão esperada = `version` do `src/chromeExtension/manifest.json`.

### Mensagens (JSON por frame WebSocket)

| Direção | Mensagem |
|---|---|
| ext→srv | `{type:'hello', token, version, userAgent}` (1º frame, ≤3 s) |
| srv→ext | `{type:'welcome', version}` · falha: fecha com código 4001 |
| ext→srv | `{type:'ping'}` a cada 20 s · srv→ext `{type:'pong'}` |
| srv→ext | `{type:'req', id, method, params}` |
| ext→srv | `{type:'res', id, ok:true, result}` ou `{type:'res', id, ok:false, error}` |

Origin exigido: `chrome-extension://<CHROME_EXTENSION_ID>`. Nova conexão válida substitui a anterior. Timeout por req: 30 s.
Se `welcome.version !== manifest.version`, a extensão chama `chrome.runtime.reload()` no máximo uma vez por versão (`chrome.storage.session`).

### Métodos (params → result)

Toda ação que atua numa aba devolve também `{tabId, url, title}`. `tabId` omitido ⇒ aba ativa da janela em foco.

- `status` → `{paused, userAgent}`
- `listTabs` → `{tabs:[{tabId, windowId, active, url, title, group?}]}`
- `snapshot {tabId?, maxChars?=6000}` → `{text}` (lista `[eN] role "nome"` + texto visível)
- `screenshot {tabId?}` → `{data}` (JPEG base64)
- `scroll {tabId?, direction?:'up'|'down', amount?:px, ref?}`
- `wait {tabId?, text?, ms?}` (máx. 25 s)
- `openTab {url}` (entra no grupo "Agent Code") · `selectTab {tabId}` · `closeTab {tabId}`
- `navigate {tabId?, url?, action?:'back'|'forward'|'reload'}`
- `click {tabId?, ref?, x?, y?}` · `type {tabId?, ref?, text, clear?, submit?}`
- `pressKey {tabId?, key}` (ex. `Enter`, `Control+a`) · `selectOption {tabId?, ref, value}`
- `evaluate {tabId?, expression}` → `{value}` (string JSON, até 8000 chars)

### Erros (texto exato em `error`)

- ref: `Ref expirada — faça um novo chrome_snapshot`
- barra cancelada: `Interrompido pelo usuário`
- pausado: `Controle pausado pelo usuário na extensão`
- página proibida: `Página bloqueada pelo Chrome para extensões`
- (servidor) desconectado: `Chrome não conectado: abra o Chrome ou instale a extensão em Configurações`
- (servidor) timeout: `Tempo esgotado aguardando o Chrome`

## Tarefas

1. T1 extensão (`src/chromeExtension/**`, `src/main/chromeBridge/extensionId.ts`, teste do ID).
2. T2 servidor da ponte (`src/main/chromeBridge/server.ts` + testes).
3. T3 integração no main: config, instalador, ferramentas MCP, hint, gate de permissão, IPC/preload, build (`extraResources`).
4. T4 UI: `ChromeControlSection.tsx` na aba Geral.
5. T5 teste de integração com Chromium do Playwright.
