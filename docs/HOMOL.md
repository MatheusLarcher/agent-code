# Agent Code Homol — variante que convive com o app instalado

A "Agent Code Homol" é uma segunda instalação do mesmo código, para testar
novidades sem tocar no Agent Code que já está em uso. As duas ficam instaladas e
abertas ao mesmo tempo, cada uma com atalho, dados e portas próprios.

## Como gerar o instalador

```
npm run package:homol
```

Faz o mesmo que `package:win` (build + `stage-skills` + `stage-postgres` +
`stage-7zip`), mas chama o electron-builder com `electron-builder.homol.yml`,
que estende o `electron-builder.yml` principal. Saída: `dist/AgentCode-Homol-setup.exe`.

O `electron-builder.yml` e o `package:win` não mudam: o build original sai igual.

Instalação silenciosa (teste): `AgentCode-Homol-setup.exe /S`. Desinstalação
silenciosa: `"%LOCALAPPDATA%\Programs\agent-code-homol\Uninstall Agent Code Homol.exe" /S`.

## Como a variante é ligada

`electron-builder.homol.yml` grava `name: agent-code-homol` no package.json
empacotado (`extraMetadata`). No boot, `src/main/devDataDirBoot.ts` lê
`app.getName()` e grava `AGENT_CODE_APP_VARIANT=homol`; `src/main/appVariant.ts`
devolve o perfil (pastas e portas) da variante. Os workers e processos filhos
herdam a variável. Sem ela (testes, scripts, build original) vale o perfil da original.

## Identidade

| Item | Original | Homol |
|---|---|---|
| appId / AppUserModelID | com.larchertech.agentcode | com.larchertech.agentcode.homol |
| productName / atalhos | Agent Code | Agent Code Homol |
| GUID do NSIS (chaves de desinstalação) | derivado do appId pelo electron-builder (o yml principal não fixa) | aa6188e2-7456-437a-9d55-959cf0252e2b |
| Pasta de instalação | %LOCALAPPDATA%\Programs\agent-code-desktop | %LOCALAPPDATA%\Programs\agent-code-homol |
| Instalador | AgentCode-setup.exe | AgentCode-Homol-setup.exe |

## Dados separados

| Dado | Original | Homol |
|---|---|---|
| userData (config.db, cofre, Postgres embutido, extensão do Chrome copiada) | %APPDATA%\agent-code-desktop | %APPDATA%\agent-code-homol |
| Pasta local da máquina | %LOCALAPPDATA%\agent-code | %LOCALAPPDATA%\agent-code-homol |
| Documentos (memórias, skills, cache) | Documentos\agent-code | Documentos\agent-code-homol |
| Pasta na home (ponteiro do cache, chaves do APK) | ~\.agent-code | ~\.agent-code-homol |
| Emulador Android (AVD) | agent_code_avd | agent_code_homol_avd |

## Portas

| Serviço | Original | Homol | Como se resolve |
|---|---|---|---|
| Postgres embutido | 45432 | 45442 | porta gravada no userData de cada uma; se ocupada, tenta as seguintes |
| Celular (ponte LAN) | 8765 | 8785 | se ocupada, tenta até +20 |
| Ponte da extensão do Chrome | 47831-47835 | 47841-47845 | cada extensão recebe as portas da sua variante no config.js |
| MCP de entrada (Forgia) | 47110-47149 | 47150-47189 | faixas de 40 que não se cruzam; o Forgia acha só a original |
| Proxy do Codex, roteador Kimi | dinâmica (porta 0) | dinâmica | sem conflito |
| Callback do login Codex | 1455 | 1455 | fixa pelo OpenAI; só colide se as duas fizerem login no Codex ao mesmo tempo |

## Extensão do Chrome

A Homol copia a extensão para o seu userData com outra `key` no manifest
(id `oagjkobmjcjkbkndhjnbojpgpbfjmbgh`) e nome "Agent Code Homol — Controle do
Chrome". O Chrome a trata como outra extensão, ao lado da original. A pasta
`src/chromeExtension` não muda.

## Skills

O `stage-skills` empacota as skills do usuário no instalador, como no original.
A Homol importa as skills de `~/.claude/skills` para o cache dela, mas não escreve
de volta em `~/.claude/skills` (lá é o app principal que gerencia). As sessões
da Homol leem as skills pela raiz nativa do cache dela.

## O que continua compartilhado (por desenho)

- `~/.claude`: login do Claude e transcrições das sessões do SDK. Sair da conta
  numa das duas limpa `~/.claude/cache` para as duas.
- `~/.android/avd`: a pasta é a mesma, mas cada uma usa um AVD com outro nome.
- A porta 1455 do login do Codex (ver tabela).

## Atualização automática

O `electron-builder.homol.yml` aponta para o fork `erickxc/agent-code` em
`win.publish` e `mac.publish`. Não use o `publish` de cima: o `extends` concatena
listas e o feed viraria o primeiro da lista, o do principal. O `publish` da
plataforma tem precedência sobre o global. O `app-update.yml` gerado dentro do instalador da
Homol traz `owner: erickxc`; o build original continua com o feed dele.
