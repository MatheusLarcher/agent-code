# Paridade PC × celular

Meta: o app do celular (`src/phone`, empacotado em `smartfone-remote/`) deve fazer tudo o que
o app do PC faz. Este documento é o inventário do que já existe e do que falta. Ele **não** é
um plano fechado: cada item vira tarefa quando for atacado.

Levantamento de 06/10/2026. As rotas da ponte estão em `src/main/remote/remoteServer.ts:339-358`
e o retrato de conversa enviado ao celular em `src/shared/ipc.ts:2374-2413`.

## Atenção: o 3D do celular é o mesmo código do PC

A aba Escritório do celular importa `@renderer/office3d/Office3DWorkspace` direto
(`src/phone/office/OfficeTab.tsx`). Qualquer ajuste visual no escritório do PC (altura da
cadeira, poses, avatares) **só chega ao celular depois de `npm run phone:build`** (que gera
`smartfone-remote/www/`) e de um APK novo. O `www/` é versionado, então um bundle velho fica
silenciosamente divergente do PC. Exemplo: em 06/10 o assento estava em 0,46 m no PC e 0,59 m
no APK. Depois de mexer em `src/renderer/src/office3d/`, rode `phone:build` e gere o APK.

## Inventário

Legenda: **sim** = já existe · **parcial** = existe em parte · **não** = falta.

| Área do PC | Celular | O que falta |
|---|---|---|
| Chat ao vivo (Markdown, cartões de ferramenta, mapa de perguntas) | sim | — |
| Anexos (imagem, arquivo, colar) | sim | Arrastar e soltar; `{{midia}}` inline |
| Rascunho por conversa | não | Guardar o rascunho por conversa (só no celular) |
| Autocomplete `@` (arquivos/projetos) e `/` (skills) | não | Rotas para listar skills e buscar arquivos do projeto |
| Referência a cartões `[[Título]]` | não | Lista de cartões pela ponte |
| Citar/comentar trecho, "Ler daqui" | parcial (só "responder a" na Central) | Citação por trecho no chat comum; deslocamento no `tts-parts` |
| Elemento escolhido no navegador → chat | não | Depende do navegador no celular |
| Fila de mensagens (Mandar agora / remover) | parcial (só o eco "Na fila") | Rotas `queue-send-now` e `queue-delete`; `queued[]` já vem no retrato |
| Modelo, esforço, modos Econ./Loop/Rápido | sim | — |
| Parar turno, recuperar turno | sim | — |
| Permissões e AskUserQuestion, "Permitir tudo" | sim | — |
| Plano de tarefas (TodoWrite) | sim | — |
| Conversas: lista, busca, nova, renomear, excluir | sim | — |
| Filtros de projeto, sandbox, nova aba, seletor de pasta | não | `conversation create` só aceita projeto que o PC já conhece |
| Central (trilho, "Para onde vai?") | sim | — |
| Navegador embutido (abas, endereço, preview de arquivo) | não | Rotas de abas/URL + captura ou stream da tela |
| Preview do Android | não | Igual ao navegador |
| Controle do Windows / do Chrome (chaves) | não | Expor as chaves na config da ponte |
| Voz: ouvir (TTS) | parcial (só "Ouvir" na resposta final) | "Ler daqui" |
| Voz: ditado (STT) | sim (Parakeet no aparelho, PC como reserva) | — |
| Escritório 3D: cena e agentes | parcial (só visualização) | Ver abaixo |
| Escritório: monitor de código e chat na tela | parcial (`chat={null}`) | Feed completo de ferramentas, não só a última |
| Escritório: TVs (Aprovar / Pedir ajuste), plano | não | `onSendToConversation`, `onStartPlanning` e rota de envio pela TV |
| Escritório: sala de reunião, chamados, quadro, memória | não | O celular ignora `office-call*` (`src/phone/core/client.ts:24`); `board: null`; subagentes, Vigia/PO/Memorista e contas vazios em `phoneFeed.ts` |
| Quadro, tarefas, subagentes | não (aba "em breve") | Rotas de leitura e de mover cartões |
| Planejamento (canvas, Handoff, Agent Manager) | não | Rotas novas |
| Entregas | parcial (só "Baixar" nos entregáveis) | Tela de Entregas |
| Memória (lista, propostas) | não | Rotas de leitura/proposta |
| Configurações (dados, PostgreSQL, Android SDK, contas, provedores) | não (só Permitir tudo, Uso, Voz, Filiais) | Rotas por seção. O cofre **não** deve passar pela ponte |
| Uso e tokens | parcial (resumo da conversa e limites) | Detalhe por turno |
| Vigia | não | Estado do Vigia no retrato |
| Ver arquivos ("Abrir em janela", "Abrir no editor") | parcial (só baixar) | Visualizador no celular |
| Avisos em segundo plano | parcial (só toasts com o app aberto) | Notificação do Android a partir de `office-call` |
| Pareamento, filiais, APK | sim | — |

## Ordem sugerida

1. **Ganhos rápidos** (a ponte já manda os dados): ações da fila, chamados do escritório e
   notificação no Android.
2. **Composer**: `@`/`/`, rascunho, citar e "Ler daqui".
3. **Quadro e Planejamento** (handoff 2 em `CONTINUIDADE-2026-10-05-celular.md`).
4. **Escritório completo**: TVs, sala de reunião, quadro e memória no 3D (handoff 4).
5. **Telas remotas**: navegador e preview do Android por captura/stream.
6. **Configurações** restantes, sem o cofre.
