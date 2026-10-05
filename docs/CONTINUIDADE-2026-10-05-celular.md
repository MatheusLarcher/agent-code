# Continuidade — App do celular, parte 1 (05/10/2026)

Registro do que a parte 1 do plano `plano-20261003-2237` (handoff revisado de 05/10: fundação + paridade) entregou e do que ficou para depois. Funcionamento atual em [ARQUITETURA.md](ARQUITETURA.md) (controle remoto → "Cliente do celular") e [REFERENCIA.md](REFERENCIA.md) (`src/phone` e `smartfone-remote`).

## Entregue

- **Base técnica:** app novo em React 19 + TS em `src/phone/`, build `npm run phone:build` (`vite.phone.config.ts`) para `smartfone-remote/www/` (gerado e versionado, nomes fixos). `tsconfig.phone.json` no `npm run typecheck`; testes no vitest da raiz. `jsqr` agora vem do npm da raiz.
- **Capacitor 6 → 8.5.2** em `smartfone-remote/`: o `buildApk.ts` roda o `phone:build` antes do `cap sync`, recria um `android/` de template antigo e garante só para o APK o **JDK 21** (`<userData>/jdk-21`), `platforms;android-36`, `build-tools` 36 e 35 (o AGP 8.13 usa o 35). O preview Android continua com JDK 17 + android-34 (`detect().ready` não mudou). Plugin `parakeet-stt` adaptado (compile 36, Java 21) — compila e está no APK.
- **Casca:** abas embaixo (Central · Conversas · Quadro reservado), volta à última aba/conversa, viewport visual (teclado) e áreas seguras por `var(--safe-area-inset-*, env(...))`, visual do desktop.
- **Paridade portada:** pareamento por QR (canvas + `<video>` escondido), auto-conexão sem takeover, "Usar este celular", LAN × relay, SSE com backoff/ressincronização/wake lock, `historyReq`, fila "Na fila", recuperação de turno, permissões e AskUserQuestion com contagem, Central completa (trilho, "Para onde vai?", `foreign`, arrastar para responder, ações do turno, perguntas dos destinos), chat (Markdown e cartões de ferramenta do desktop, mapa de perguntas, puxar-para-atualizar, ir ao final, plano, Parar), composer (anexos, ditado no aparelho com plano B no PC, "Ouvir", modelo/esforço sem fechar o dropdown, Econ./Loop/Rápido), conversas com busca/nova/renomear/excluir, Configurações (Permitir tudo, uso, Voz, conexão/sair). O JS antigo saiu do `www/` (está no git).
- **Ponte de teste:** `node scripts/phone/dev-bridge.mjs` sobe o `RemoteServer` real com estado simulado; `scripts/phone/build-apk-runner.mjs` gera o APK com o código do `buildApk.ts` fora do Electron.

## Validado de fato

- `npm run typecheck`, `npm test` (5612 testes) e `npm run build` verdes; `npm run phone:build` gera o `www/`.
- APK do Capacitor 8 gerado pelo `buildApk.ts` (2ª passada idempotente: não recria o `android/` nem baixa nada) e inspecionado: `androidScheme: http` + `cleartext`, `usesCleartextTraffic`, `density` em `configChanges`, min 24 / target 36, CAMERA/RECORD_AUDIO/WRITE_EXTERNAL_STORAGE, libs do sherpa-onnx nas 4 ABIs, `ParakeetSttPlugin` e `MainActivity$DownloadBridge` no dex.
- No navegador embutido contra a ponte de teste (o `RemoteServer` real): auto-configuração por `/app/?token=`, volta à última tela, histórico + Markdown + cartões, enviar e receber a resposta ao vivo, AskUserQuestion com 2 perguntas (resposta chegou certa no PC), "sem resposta há…", plano de tarefas, Central ("Para onde vai?" escolhido, pergunta de destino respondida, pedido de outro PC sem botões), ponte desligada → "offline · reconectando…" com o motivo → volta sozinho ao religar.
- Decodificação do QR no formato exato do PC (`decode.test.ts`, QR gerado pelo `qrcode` e lido pelo `jsqr`).

## Falta (para fazer depois)

1. **Validação no emulador** (critérios 1–5 do handoff): instalar o APK novo, parear, reabrir sem novo QR, ditado no aparelho, baixar arquivo para Downloads (`AgentDownload`), teclado/barra de abas, estados (sem conversas, token inválido, outro celular). Não foi feita porque o emulador do preview (headless, ligado desde 04/10 21:15) travou: aparece no `adb devices`, mas `adb shell` não responde. Reiniciar o preview e rodar de novo.
2. **QR pela câmera:** o AVD usa `hw.camera.back = emulated` (padrão sintético), então não lê QR. Validar num celular real ou num AVD com `virtualscene` + pôster com o QR.
3. **Relay (VPS)** com o app novo: só a LAN/ponte de teste foi exercitada. Cuidado: parear com o PC real pelo relay pode tomar o lugar do celular pareado do usuário.
4. **APK antigo com o PC atualizado:** não reexecutado. O contrato não mudou (`remoteServer.ts` intocado, nenhuma rota alterada); o APK antigo está guardado em `%TEMP%\agent-remote-old\agent-remote-cap6.apk`.
5. **Ditado local (Parakeet) no aparelho:** compila e está no APK, mas não foi exercitado (instalar o modelo pelo card Voz e ditar).
6. **Edge-to-edge do Android 15+:** o emulador é API 34 (não força edge-to-edge); conferir barra de abas e composer num Android 15/16.
7. **Preview Android do desktop:** o `detect()` não mudou, mas o preview não foi reaberto depois da troca.
8. Pequenos: puxar-para-atualizar na Central não foi portado (o poll de 4 s e a releitura logo após cada ação cobrem); o botão voltar do Android fecha o app (sem `@capacitor/app`, como antes).
9. A tarefa do registro "Capacitor 6→8 …" (`cf4248a1`) ficou `pending` sem a revisão final.
10. **Próximas partes do plano:** os handoffs 2 (rotas novas + Quadro, Planejamento, Uso, Ler daqui/Citar), 3 (avisos em segundo plano) e 4 (Escritório 3D) serão regenerados a partir do plano; os arquivos antigos `2026-10-03-02..04` foram ignorados, como manda o handoff revisado.
