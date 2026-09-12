# `safeStorage` no app empacotado — validação

Fecha o item que a spec do registro de tarefas deixou em aberto: *"falta a
validação do portátil com `safeStorage` real"*. O que estava em jogo é o caminho
que grava segredo em disco — a API key da OpenAI (`config.ts`), os tokens OAuth
do ChatGPT (`codexAuth.ts`) e a senha do PostgreSQL (bootstrap). Os três **falham
fechado**: sem `safeStorage` disponível eles recusam gravar em vez de cair para
texto puro. Faltava provar que, no build empacotado, eles não recusam — e que o
que foi gravado volta.

## Como foi medido (12/09/2026)

Instância isolada de `dist/win-unpacked/Agent Code.exe` (`app.isPackaged === true`),
com `--user-data-dir` próprio e `USERPROFILE`/`HOME` apontando para uma pasta
descartável, para não tocar a instalação em uso. A chave foi digitada em
**Configurações → Voz** e salva pela tela, que é o caminho real do usuário.

| O que | Resultado |
|---|---|
| `safeStorage.isEncryptionAvailable()` no processo empacotado | `true` |
| `config.openai.apiKey` no `persistent_kv_v2` | `{"safeStorage":"djEw…"}` — `djEw` é o cabeçalho `v10` do OSCrypt |
| Busca por `sk-…` em texto puro no KV inteiro | nenhuma ocorrência |
| `decryptString` do blob gravado | devolve exatamente o valor digitado |
| `encryptString` → `decryptString` num valor novo | volta idêntico |

## O achado: o texto cifrado é preso ao `Local State` do `userData`

Decifrar o mesmo blob a partir de um app Electron com **outro `userData`** falha
com `Error while decrypting the ciphertext provided to safeStorage.decryptString`,
mesmo sendo a mesma conta do Windows e com `isEncryptionAvailable() === true`.

No Windows o Chromium não cifra com DPAPI direto: ele gera uma chave aleatória,
cifra **essa chave** com DPAPI e a guarda no arquivo `Local State` dentro do
`userData`. A conta do Windows sozinha não basta — o par `userData` + conta é que
abre.

Duas consequências práticas:

- **Copiar só a pasta de dados não leva os segredos do `safeStorage`.** O
  `agent-code.db` viaja com o envelope cifrado, mas sem o `Local State` do
  `userData` de origem ele é ilegível. Isso vale para a API key da OpenAI, os
  tokens do ChatGPT e a senha do PostgreSQL — e **não** para o cofre de senhas
  das memórias, que guarda a própria chave junto (`vault/secret-vault.json`,
  espelhado no banco) exatamente para não ter esse problema.
- **Isolar um teste redirecionando `APPDATA` não funciona** e nem chega a abrir:
  o Electron resolve `appData` pela API do sistema, não pela variável, e o app
  morre com `Failed to get 'userData' path`. Para testar isolado use o app
  descompactado com `--user-data-dir` (o stub portátil não repassa argumentos —
  ver o aviso em ARQUITETURA.md sobre o guarda de reinício).

## O que isto não cobre

Só Windows. No Linux o `safeStorage` depende de kwallet/gnome-libsecret e pode
resolver `isEncryptionAvailable() === false` numa sessão sem keyring — nesse
caso os três caminhos recusam a gravação, que é o comportamento desejado, mas
não foi exercitado aqui.
