# Agent Remote (smartfone-remote)

App Android para **controlar pelo celular** o mesmo Claude Code que roda no app de PC
(`agent-code-desktop`). O celular **envia comandos** e **acompanha** a conversa e o que está
sendo construído; quem aprova permissões é o PC.

```
Celular (Agent Remote)  ──HTTP/SSE──►  PC (app desktop, ponte LAN)  ──►  Claude Code
        envia comando                  recebe e repassa ao agente
        ◄── eventos ao vivo (SSE) ──   transmite a conversa de volta
```

Hoje a conexão é **só por rede local (Wi‑Fi)**. Um servidor "blocker"/broker pode ser plugado
depois sem mudar o app — o transporte (HTTP + SSE) é isolado em `src/main/remote/`.

## Como conectar

1. No PC, abra o app desktop e clique no botão **📱 (Controle remoto)** no topo → **Ligar ponte**.
   Aparece um **QR** com a URL (`http://IP:PORTA/?token=...`).
2. No celular, abra o app **Agent Remote** e toque **📷 Escanear QR** — a câmera lê o QR e
   conecta automaticamente. Pronto.
3. Escolha a conversa, veja o histórico ao vivo e envie comandos. O histórico inicial traz as 30 mensagens mais recentes; novas mensagens chegam em tempo real.

> O celular precisa estar na **mesma rede Wi‑Fi** do PC.

Não tem o app instalado? Baixe o APK na página `http://IP:PORTA` (botão **⬇️ Baixar APK**) ou use
o cliente web em `http://IP:PORTA/app`. Há também a opção **inserir endereço manualmente** na tela
de conexão (fallback quando a câmera não estiver disponível).

## Estrutura

```
www/                 app web servido dentro do APK (e em /app pelo PC)
  index.html
  app.js             pareamento, lista, histórico, SSE ao vivo, envio
  styles.css         tema escuro espelhando o desktop
capacitor.config.json  appId com.matheus.agentremote · androidScheme http + cleartext
scripts/build-apk.mjs  build via CLI (assume toolchain instalada)
android/             gerado por `cap add android` (gitignored)
dist/                saída: agent-remote.apk (gitignored, servido em /download)
```

## Gerar o APK

**Pela UI (recomendado):** no app de PC, painel 📱 → **Gerar APK**. Reusa o Android SDK do
preview Android e soma o que o Capacitor 8 exige só para o APK (JDK 21 em `<userData>/jdk-21`,
`platforms;android-36`, `build-tools` 36.0.0 e 35.0.0, o padrão do AGP 8.13), baixando na 1ª vez. Antes do `cap sync` roda
`npm run phone:build` na raiz (gera `www/` a partir de `src/phone`); um `android/` de template
antigo (compileSdk < 36) é recriado. Publica em `dist/agent-remote.apk`.

**Pela CLI** (JDK 21 + Android SDK com android-36: os do app ou `JAVA_HOME`/`ANDROID_HOME`):

```bash
node scripts/phone/build-apk-runner.mjs   # na raiz: o mesmo código do botão Gerar APK
# ou (não instala nada; usa o toolchain já presente):
cd smartfone-remote && npm install && npm run build:apk
```

O `.apk` sai em `smartfone-remote/dist/agent-remote.apk` e é servido pelo PC em `/download`.

## Notas

- `androidScheme: http` + `cleartext: true` permitem o WebView falar HTTP com o PC na LAN
  (sem isso o Android bloqueia tráfego em texto puro / mixed content).
- O leitor de QR usa a câmera via `getUserMedia` + `jsQR` (npm da raiz, entra no build do celular), sem plugin nativo. O
  script de build injeta a permissão `CAMERA` no `AndroidManifest.xml` gerado.
- Sem precisar do APK, o cliente web em `http://IP:PORTA/app` já funciona no navegador do celular.
- Você pode anexar imagens, baixar entregáveis do chat e trocar o modelo/esforço da conversa pelo celular. Os controles ficam desabilitados enquanto o agente está trabalhando.
