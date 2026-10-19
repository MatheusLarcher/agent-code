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
npm test         # teste de integração (round-trip + isolamento + SSE)
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
| `FCM_SERVICE_ACCOUNT_FILE` | vazio | caminho (dentro do container) do JSON da conta de serviço do Firebase `agent-code-c6c23`: liga o push no celular (frame `push`). Sem ela, o PC recebe `fcm-desligado` e o aviso fica no Windows. Alternativa: `FCM_SERVICE_ACCOUNT` com o JSON inteiro. |

> `.env`/`.env-prod` não vão pro git (segredo fica no cofre). O relay é roteado por token; o
> `RELAY_KEY` é só uma porta de entrada opcional.
