# agent-code broker

Relay de **acesso remoto multiusuário** do controle remoto do agent-code, roteado pelo **token**
de cada instalação. Sem senha de VPS, sem abrir porta no PC.

```
Celular → https://agent-code.larchertech.com/?token=XYZ → Cloudflare → Nginx(VPS)
        → broker (:8099) → [WebSocket de saída] → PC do usuário com token XYZ → RemoteServer
```

- O **PC disca pra fora** (WebSocket `/__relay`) e se registra com o seu token.
- O **celular** faz HTTP normal; o broker acha o PC pelo `?token=` e faz o relay (incl. **SSE**).
- **Stateless** (só o mapa token→conexão em memória). Sem banco, sem backup.

## Rodar local (dev)
```bash
npm install
npm start        # ouve em :8099
npm test         # testes de integração (relay do celular, push e canal de suporte)
```

## Deploy na VPS (Docker)
1. Suba a pasta `broker/` pra VPS (Bitvise).
2. (Opcional) defina `RELAY_KEY` no `.env-prod` e rebuilde o app com a mesma chave.
3. ```bash
   docker compose down && docker compose up -d --build
   ```
   O broker fica em `127.0.0.1:8099` (só o Nginx fala com ele).
4. Aponte o Nginx pro broker com upgrade de WebSocket — use `scripts/vps-remote-broker.sh`
   (na raiz do projeto), que já gera o site com os cabeçalhos certos.

## Config (env)
| Var | Default | O quê |
|-----|---------|-------|
| `PORT` | `8099` | porta do broker (atrás do Nginx) |
| `RELAY_KEY` | vazio | se definido, só aceita PCs que mandem a mesma chave (anti-abuso). O **token do app** continua sendo a auth real. |
| `SUPORTE_KEY` | vazio | chave da equipe do **suporte remoto**. Sem ela o canal de suporte inteiro recusa (HTTP 503, exe negado). Só quem tem a chave consegue pedir acesso a um exe; o cliente ainda precisa aceitar na tela dele. |
| `FCM_SERVICE_ACCOUNT_FILE` | vazio | caminho (dentro do container) do JSON da conta de serviço do Firebase `agent-code-c6c23`: liga o push no celular (frame `push`). Sem ela, o PC recebe `fcm-desligado` e o aviso fica no Windows. Alternativa: `FCM_SERVICE_ACCOUNT` com o JSON inteiro. |

## Suporte remoto (`src/suporte.js`)

Canal à parte, no mesmo servidor, que não muda o caminho do celular. O exe do cliente
(`AgentCode-Suporte.exe`) disca pra cá, mostra um código e espera; o Agent Code do técnico
pareia e passa a mandar chamadas MCP que descem até o exe pela conexão que ele abriu.

| Rota | Quem chama | O quê |
|------|-----------|-------|
| `/__suporte` (WebSocket) | exe do cliente | anuncia o código e fica esperando; recebe o pedido de acesso e as chamadas |
| `POST /suporte/parear` | Agent Code | cabeçalho `x-suporte-chave` + `{codigo, tecnico}`; devolve `{sessao, token, info}` ou `{erro}` |
| `/suporte/mcp/<sessão>` | Agent Code | chamadas MCP (`Authorization: Bearer <token>`), repassadas ao exe |
| `GET /suporte/eventos/<sessão>` | Agent Code | fluxo (SSE) de estado: conectado, recurso, admin, caiu, encerrado |
| `POST /suporte/encerrar/<sessão>` | Agent Code | encerra a sessão pelo lado do técnico |
| `GET /suporte` | cliente | redireciona (302) para o download do exe na release mais recente |

Proteções: código ou chave errados 5 vezes por minuto bloqueiam o endereço por 10 minutos; um
técnico por código, e o código vale para uma sessão só; até 50 exes conectados; chamada de até
32 MB; exe sem técnico por 15 minutos ou mudo por 65 s é desconectado. O token nasce no exe, no
clique do cliente; aqui fica só o hash dele. O log diz apenas "pareou / recusou / caiu".

> `.env`/`.env-prod` não vão pro git (segredo fica no cofre). O relay é roteado por token; o
> `RELAY_KEY` é só uma porta de entrada opcional.
