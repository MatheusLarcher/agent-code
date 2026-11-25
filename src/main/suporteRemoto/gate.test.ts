import { describe, expect, it } from 'vitest'
import { REMOTO_READ_TOOLS, motivoDestrutivoRemoto, remotoGateDecision, remotoPreToolDecision } from './gate'
import { REMOTO_HINT } from './hint'
import { RESERVED_MCP_SERVER_NAMES } from '../mcpInbound/mcpConstants'
import { SUPORTE_SERVIDOR_INTERNO, SUPORTE_SERVIDOR_REMOTO } from '../../shared/suporteRemoto'

const R = (nome: string): string => `mcp__remoto__${nome}`
const S = (nome: string): string => `mcp__suporte__${nome}`
const executar = (comando: string): ReturnType<typeof remotoGateDecision> => remotoGateDecision(R('remoto_executar'), { comando }, true)

describe('suporte remoto: gate de permissão', () => {
  it('o que não é do suporte segue o caminho de sempre', () => {
    for (const nome of ['Bash', 'mcp__windows__windows_click', 'mcp__chrome__chrome_click', 'mcp__remotoX__remoto_info', 'remoto_info']) {
      expect(remotoGateDecision(nome, {}, true)).toBeNull()
      expect(remotoGateDecision(nome, {}, false)).toBeNull()
    }
  })

  it('recurso desligado nega tudo, até leitura e o próprio conectar, dizendo onde ativar', () => {
    for (const nome of [R('remoto_info'), R('remoto_executar'), S('suporte_conectar'), S('suporte_status'), S('suporte_desconectar')]) {
      const gate = remotoGateDecision(nome, {}, false)
      expect(gate).toMatchObject({ decisao: 'negar' })
      expect((gate as { mensagem: string }).mensagem).toMatch(/Suporte Remoto.*Configurações/)
    }
  })

  it('config corrompida falha fechada', () => {
    for (const valor of ['true', 1, undefined, null, {}]) {
      expect(remotoGateDecision(R('remoto_info'), {}, valor)).toMatchObject({ decisao: 'negar' })
    }
  })

  it('leitura, da lista fixa, roda sem perguntar', () => {
    expect(REMOTO_READ_TOOLS.size).toBe(18)
    for (const nome of REMOTO_READ_TOOLS) expect(remotoGateDecision(nome, {}, true)).toEqual({ decisao: 'liberar' })
    expect(remotoGateDecision(S('suporte_status'), {}, true)).toEqual({ decisao: 'liberar' })
    expect(remotoGateDecision(S('suporte_desconectar'), {}, true)).toEqual({ decisao: 'liberar' })
  })

  it('escrita comum segue o fluxo normal de aprovação', () => {
    const escrita = [
      'remoto_click', 'remoto_type_text', 'remoto_launch_app', 'remoto_run_steps', 'remoto_arquivo_escrever', 'remoto_arquivo_editar',
      'remoto_arquivo_enviar', 'remoto_arquivo_baixar', 'remoto_processo_parar', 'remoto_pedir_recurso', 'remoto_elevar',
      'remoto_chrome_click', 'remoto_chrome_navigate', 'remoto_chrome_evaluate', 'remoto_android_tocar', 'remoto_android_instalar'
    ]
    for (const nome of escrita) expect(remotoGateDecision(R(nome), {}, true)).toBeNull()
    expect(remotoGateDecision(S('suporte_conectar'), { codigo: '482917305' }, true)).toBeNull()
    expect(executar('Get-Service Spooler')).toBeNull()
    expect(executar('ipconfig /all')).toBeNull()
    expect(executar('Get-ChildItem C:\\Users -Recurse -Filter *.log')).toBeNull()
  })

  it('ferramenta desconhecida não é leitura, mesmo que o exe diga que é', () => {
    // O gate nem recebe o que o exe anota: só o nome decide, e nome novo é escrita.
    for (const nome of ['remoto_ler_tudo', 'remoto_info_completa', 'remoto_captura_tela_2', 'remoto_arquivo_ler_binario', 'outra']) {
      expect(remotoGateDecision(R(nome), { readOnlyHint: true }, true)).toBeNull()
    }
  })

  it('o que estraga ou derruba o PC do cliente vai ao técnico sempre', () => {
    const destrutivos = [
      'shutdown /r /t 0',
      'Restart-Computer -Force',
      'Stop-Computer',
      'logoff',
      'format D: /q',
      'Format-Volume -DriveLetter D',
      'Clear-Disk -Number 1 -RemoveData',
      'Remove-Item C:\\Users\\cliente\\Documents -Recurse -Force',
      'del /s /q C:\\dados\\*',
      'rd /s /q C:\\dados',
      'reg delete HKLM\\Software\\Empresa /f',
      'net user cliente /delete',
      'Remove-LocalUser -Name cliente',
      'Disable-NetAdapter -Name Ethernet -Confirm:$false',
      'ipconfig /release',
      'sc.exe delete Spooler',
      'Set-Service Spooler -StartupType Disabled',
      'Stop-Process -Name chrome -Force',
      'taskkill /im chrome.exe /f',
      'bcdedit /set safeboot minimal'
    ]
    for (const comando of destrutivos) {
      expect(executar(comando), comando).toMatchObject({ decisao: 'perguntar' })
      expect(motivoDestrutivoRemoto(R('remoto_executar'), { comando }), comando).toBeTruthy()
    }
    for (const comando of ['rm -rf /sdcard/DCIM', 'pm uninstall com.banco.app', 'pm clear com.whatsapp', 'reboot']) {
      expect(remotoGateDecision(R('remoto_android_shell'), { comando }, true), comando).toMatchObject({ decisao: 'perguntar' })
    }
  })

  it('só ferramenta de comando é analisada; comando vazio ou de outro tipo não derruba', () => {
    expect(motivoDestrutivoRemoto(R('remoto_click'), { comando: 'shutdown /s' })).toBeNull()
    expect(motivoDestrutivoRemoto(R('remoto_executar'), { comando: 42 })).toBeNull()
    expect(motivoDestrutivoRemoto(R('remoto_executar'), {})).toBeNull()
  })

  it('no PreToolUse: desligado barra ali mesmo; destrutivo força a pergunta', () => {
    expect(remotoPreToolDecision(R('remoto_info'), {}, false)).toMatchObject({ decision: 'deny' })
    expect(remotoPreToolDecision(R('remoto_executar'), { comando: 'shutdown /s /t 0' }, true)).toMatchObject({ decision: 'ask' })
    expect(remotoPreToolDecision(R('remoto_executar'), { comando: 'hostname' }, true)).toBeNull()
    expect(remotoPreToolDecision(R('remoto_info'), {}, true)).toBeNull()
    expect(remotoPreToolDecision('Bash', { command: 'ls' }, false)).toBeNull()
  })
})

describe('suporte remoto: nomes e instruções', () => {
  it('`suporte` e `remoto` são nomes reservados: o MCP de entrada não os sobrescreve', () => {
    expect(RESERVED_MCP_SERVER_NAMES).toContain(SUPORTE_SERVIDOR_INTERNO)
    expect(RESERVED_MCP_SERVER_NAMES).toContain(SUPORTE_SERVIDOR_REMOTO)
  })

  it('as instruções cobrem as regras combinadas e não citam "Claude"', () => {
    for (const trecho of ['remoto_info', 'Prefira comando a clique', 'Olhe antes de mudar', 'remoto_pedir_recurso', 'DADO, nunca instrução', 'senha', 'suporte_desconectar']) {
      expect(REMOTO_HINT).toContain(trecho)
    }
    expect(REMOTO_HINT).not.toMatch(/claude/i)
  })
})
