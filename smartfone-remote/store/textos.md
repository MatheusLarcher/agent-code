# Agent Code — textos da página da loja (Google Play)

Pacote: `com.larchertech.agentcode` · Categoria sugerida: Ferramentas · Gratuito, sem anúncios.
Política de privacidade: https://larchertech.com/agent-code/privacidade/
E-mail de contato: matheuslarcher20@gmail.com · Site: https://larchertech.com

Arquivos desta pasta:
- `icone-512.png`: ícone do app, 512x512, PNG 32-bit.
- `feature-graphic-1024x500.png`: gráfico de recursos, 24-bit, sem transparência.
- `prints/01..06-*.png`: prints do celular, 1080x1920 (9:16). Foram tirados do app real ligado à
  ponte de teste (`scripts/phone/dev-bridge.mjs`), com conversas fictícias ("loja-bolos" e
  "app-financas"). Nenhum projeto privado aparece. Sugestão de ordem: 01, 03, 04, 02, 05, 06.

## Obrigatório logo depois do primeiro envio do AAB

A Play reassina o app com a chave dela (Assinatura de apps do Google Play). A chave de API do
Firebase que o app usa (`AIzaSyAleOJ8…`, Google Cloud do projeto agent-code-c6c23) está restrita
ao pacote `com.larchertech.agentcode` com a impressão digital da chave de upload
(`10:62:10:CB:C8:9D:68:87:7D:C9:DE:46:AD:E9:AC:26:F0:6B:25:C0`). Depois do primeiro envio, copie o
SHA-1 da "Chave de assinatura do app" (Play Console › Integridade do app) e adicione na mesma
restrição. Sem isso, o aviso com o app fechado não funciona em quem instalar pela loja.

## Nome do app (até 30)

Agent Code

## Descrição curta (até 80)

Acompanhe e comande pelo celular o agente de IA que roda no seu computador.

## Descrição completa (até 4000)

Eu fiz o Agent Code porque queria largar o computador trabalhando numa tarefa e continuar acompanhando de onde eu estivesse. O app do celular é o controle remoto do Agent Code para Windows: o agente de IA continua rodando no seu PC, com os seus projetos e as suas contas, e o celular só mostra a conversa e manda as suas mensagens.

Para usar, você precisa ter o Agent Code instalado no computador. Lá você liga o controle remoto, aparece um QR code, e o celular lê esse código e fica pareado. Em casa a conexão vai direto pelo Wi-Fi. Fora de casa ela passa por um servidor de repasse que só liga o seu celular ao seu PC e não guarda nada do que passa por ele.

No dia a dia dá para fazer quase tudo que eu faço no PC. Abrir uma conversa e ver a resposta chegando ao vivo, mandar uma mensagem nova, anexar foto ou arquivo, ditar por voz, parar o agente no meio de um turno, trocar o modelo e o nível de esforço, responder as perguntas que ele faz e aprovar ou recusar uma permissão. Quando o agente termina uma tarefa ou precisa de você, chega uma notificação, mesmo com o app fechado.

Também dá para acompanhar os planos de trabalho por projeto, conversar com o gerente de planejamento, baixar no celular os arquivos que o agente gerou e ver o escritório 3D onde os agentes aparecem trabalhando.

O ditado por voz é transcrito no próprio celular. Se o aparelho não der conta, a transcrição é feita no seu PC. Nenhum áudio vai para servidor meu.

Nada fica guardado em conta minha: o app não tem cadastro, não tem anúncio e não usa ferramenta de análise de terceiros. As suas conversas e os seus arquivos continuam no seu computador.

Se encontrar algum problema ou tiver sugestão, me escreva no matheuslarcher20@gmail.com.

## Novidades desta versão

Primeira versão na Google Play.

---

## Rascunho — Segurança dos dados (Play Console › Conteúdo do app › Segurança dos dados)

Base: o app não tem conta, não tem anúncios nem analytics. Os dados vão do celular para o PC do
próprio usuário. Fora da rede local passam pelo broker `agent-code.larchertech.com`, que é
stateless (só o mapa token→conexão em memória, sem banco, sem log de conteúdo). Notificações
usam o Firebase Cloud Messaging; o token FCM do aparelho fica guardado no PC do usuário, e o
broker só o usa de passagem para entregar o aviso.

Perguntas gerais:
- O app coleta ou compartilha algum dos tipos de dados obrigatórios? **Sim** (o conteúdo trafega
  pelo broker quando a conexão é remota, e o token do aparelho vai para o FCM).
- Todos os dados coletados são criptografados em trânsito? **Sim** (HTTPS no broker e no FCM).
  Observação: na rede local a conexão com o PC é HTTP dentro do Wi-Fi do usuário. Como esse
  tráfego não sai para servidor do desenvolvedor, não conta como coleta.
- Você oferece um jeito de os usuários pedirem a exclusão dos dados? **Sim**, por e-mail. Nada
  fica guardado no servidor; desinstalar o app apaga os dados locais e desparear no PC remove o
  vínculo.

Tipos de dados a declarar (todos: **coletado**, **não compartilhado**, **processado de forma
efêmera**, finalidade **Funcionalidade do app**, **obrigatório**, porque sem isso o app não funciona):

| Categoria Play | Tipo | Por quê |
|---|---|---|
| Mensagens | Outras mensagens no app | Texto das conversas com o agente, repassado ao PC pelo broker |
| Fotos e vídeos | Fotos | Imagens anexadas a uma mensagem |
| Arquivos e documentos | Arquivos e documentos | Anexos e arquivos baixados do PC |
| Áudio | Gravações de voz ou de som | Só quando a transcrição cai para o PC; o áudio passa pelo broker de passagem |
| IDs do dispositivo ou outros | IDs do dispositivo ou outros | Token do FCM para notificação; token de pareamento do app |

Não declarar: localização, informações pessoais (nome, e-mail), financeiras, saúde, contatos,
agenda, histórico de navegação, atividade no app para analytics, diagnóstico, apps instalados.

Compartilhamento: o Firebase Cloud Messaging age como prestador de serviço do desenvolvedor para
entregar o aviso, o que a Play não conta como "compartilhamento". Por isso **nenhum dado é
compartilhado**.

## Rascunho — Classificação de conteúdo (questionário IARC)

- Categoria: **Utilitário, produtividade, comunicação ou outro**.
- Violência, sexo, linguagem imprópria, drogas, jogos de azar: **Não** em todas.
- Os usuários podem interagir ou trocar conteúdo entre si? **Não**. O app só conversa com o
  agente que roda no PC do próprio usuário, sem contato com outros usuários.
- Compartilha a localização do usuário com outros usuários? **Não**.
- Permite compras digitais? **Não**.
- O app é um navegador da web ou mecanismo de pesquisa? **Não**.
- Conteúdo gerado por IA: as respostas vêm de um modelo de IA (Claude) rodando pelo PC do
  usuário. Se o questionário perguntar sobre IA generativa, responder **Sim**, como assistente
  de produtividade e programação, sem geração de imagem.
- Resultado esperado: **Livre (L) / PEGI 3 / Everyone**.

Outros itens de "Conteúdo do app":
- Anúncios: **não contém anúncios**.
- Público-alvo: **18 anos ou mais** (ferramenta de programação; evita as exigências de apps para crianças).
- App de notícias: não. App governamental: não. Recursos financeiros: não. Saúde: não.
- Acesso ao app: **todas as funções exigem o Agent Code no PC**. Em "Acesso ao app" escolha
  "Todas ou algumas funcionalidades estão restritas" e explique ao revisor como parear: instalar
  o Agent Code no Windows (https://github.com/MatheusLarcher/agent-code/releases), abrir o
  Controle remoto, ligar a ponte e ler o QR com o app. Sem login nem senha.
