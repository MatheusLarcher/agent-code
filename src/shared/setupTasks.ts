/**
 * Tarefas de configuração que o próprio agente executa no lugar do usuário.
 *
 * Cada tarefa é um pedido pronto: o botão da tela abre um chat de sandbox e
 * manda o `prompt`; na bolha aparece só o `display`. O agente usa as
 * ferramentas que já tem (controle do Windows, Chrome, terminal) — nada aqui
 * roda sozinho, e o usuário acompanha e aprova pelo chat como em qualquer pedido.
 */

export type SetupTaskId = 'chrome-extension'

export interface SetupTask {
  id: SetupTaskId
  /** O que aparece na bolha do usuário. */
  display: string
  /** O pedido inteiro, que vai ao agente. */
  prompt: string
}

/** Só caminho absoluto do Windows ou POSIX, sem quebra de linha: ele entra no prompt. */
function safeDir(dir: string): string {
  const clean = dir.trim()
  if (!clean || /[\r\n`]/.test(clean) || !(/^[A-Za-z]:[\\/]/.test(clean) || clean.startsWith('/'))) {
    throw new Error('Pasta da extensão inválida')
  }
  return clean
}

/** Instalar a extensão do Agent Code no Chrome do usuário, a partir da pasta já preparada. */
export function chromeExtensionSetupTask(extensionDir: string): SetupTask {
  const dir = safeDir(extensionDir)
  const prompt = [
    'Instale a extensão "Agent Code" no meu Google Chrome. Faça você mesmo, pela tela, com as ferramentas windows_* (controle do Windows) — não me peça para clicar.',
    '',
    'A pasta da extensão já está pronta, não precisa copiar nem editar nada nela:',
    dir,
    '',
    'Passos:',
    '1. Se o Chrome não estiver instalado, instale antes com: winget install -e --id Google.Chrome --accept-source-agreements --accept-package-agreements',
    '2. Descubra os perfis do Chrome: no arquivo %LOCALAPPDATA%\\Google\\Chrome\\User Data\\Local State (JSON), a chave profile.info_cache lista cada pasta de perfil ("Default", "Profile 1"…) com o nome dela. Com um perfil só, use-o. Com mais de um, pergunte-me em qual instalar (AskUserQuestion com os nomes; se dois tiverem o mesmo nome, mostre também a pasta) antes de abrir qualquer coisa.',
    '3. Abra uma janela do Chrome nesse perfil: windows_launch_app com app "chrome" e o argumento --profile-directory=<pasta do perfil>. Não passe chrome://extensions como argumento: o Chrome ignora esse endereço na linha de comando. Se aparecer a janela "Quem está usando o Chrome?", clique no perfil escolhido.',
    '4. Na janela que abriu, escreva chrome://extensions na "Barra de endereço e de pesquisa" e confirme com Enter.',
    '5. Veja se a extensão já está neste perfil (campo "Pesquise extensões" com o texto Agent Code). Se já existe um cartão "Agent Code", não carregue outro: só deixe ativado e, se o cartão mostrar erro, use o "Recarregar" dele. Pule para o passo 9.',
    '6. Ligue o "Modo do desenvolvedor" (canto superior direito), se estiver desligado.',
    '7. Clique em "Carregar sem compactação" (em inglês, "Load unpacked").',
    '8. Na janela de escolher pasta, escreva o caminho acima no campo "Pasta" e confirme em "Selecionar pasta".',
    '9. Confira na tela que o cartão "Agent Code" está ativado e sem erro. Depois confirme a conexão com a ferramenta chrome_status: conectada = terminou.',
    '',
    'Regras:',
    '- Não mexa em outras extensões nem em outras configurações do Chrome, e não feche abas nem janelas minhas. No fim, feche só a janela que você abriu.',
    '- Se algo impedir (política da empresa bloqueando o modo do desenvolvedor, ferramenta windows_* recusada, janela que não aparece), pare e diga exatamente o que apareceu na tela. Não tente outro caminho, como editar arquivos do perfil do Chrome ou o registro.',
    '',
    'No fim, responda em uma ou duas linhas: instalada e conectada, ou o que faltou.'
  ].join('\n')
  return { id: 'chrome-extension', display: 'Instale a extensão do Agent Code no meu Chrome.', prompt }
}
