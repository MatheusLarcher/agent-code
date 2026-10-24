; Trechos próprios do instalador NSIS (incluídos pelo electron-builder via nsis.include).
;
; O instalador é de um clique e por usuário (%LOCALAPPDATA%\Programs\Agent Code,
; HKCU), sem UAC — é o que deixa o app instalar a versão nova sozinho, em silêncio
; (`AgentCode-setup.exe --updated /S --force-run`).
;
; Quem instalou as versões antigas tem o app em Program Files (HKLM), com o
; instalador assistido de antes. Na PRIMEIRA instalação manual desta versão, este
; customInit remove essa instalação por máquina com um UAC só: copia o
; desinstalador antigo para fora da pasta e roda ele elevado, em silêncio,
; preservando os dados do usuário (/KEEP_APP_DATA --updated). Cancelar o UAC ou
; qualquer falha não interrompe a instalação: a versão nova entra na pasta do
; usuário mesmo assim e a antiga fica para o usuário remover pelo Painel de Controle.
;
; Em instalação silenciosa (/S, a do próprio app ao atualizar) não faz nada: já é
; por usuário e não há UAC para pedir.

!include LogicLib.nsh

; Só no instalador: na passada do desinstalador (BUILD_UNINSTALLER) o customInit não
; entra e variável declarada sem uso vira o aviso 6001, que o electron-builder trata
; como erro.
!ifndef BUILD_UNINSTALLER
Var /GLOBAL agentCodeOldDir
Var /GLOBAL agentCodeOldUninstaller
Var /GLOBAL agentCodeOldUninstallerTemp
!endif

; Extrai o caminho entre as primeiras aspas de UninstallString ('"C:\...\Uninstall X.exe" /allusers').
; Entrada: $R0 = UninstallString. Saída: $agentCodeOldUninstaller (vazio se não houver aspas).
!macro agentCodeUninstallerFromString
  StrCpy $agentCodeOldUninstaller ""
  StrCpy $R1 $R0 1
  ${If} $R1 == '"'
    StrCpy $R0 $R0 "" 1
    StrCpy $R2 0
    ${Do}
      StrCpy $R1 $R0 1 $R2
      ${If} $R1 == '"'
      ${OrIf} $R1 == ""
        ${ExitDo}
      ${EndIf}
      IntOp $R2 $R2 + 1
    ${Loop}
    StrCpy $agentCodeOldUninstaller $R0 $R2
  ${EndIf}
!macroend

!macro customInit
  ${IfNot} ${Silent}
    ; Instalação por máquina registrada em HKLM? (a vista de registro já é a de 64 bits)
    ReadRegStr $agentCodeOldDir HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $R0 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ${If} $agentCodeOldDir != ""
    ${OrIf} $R0 != ""
      !insertmacro agentCodeUninstallerFromString
      ${If} $agentCodeOldUninstaller == ""
      ${AndIf} $agentCodeOldDir != ""
        StrCpy $agentCodeOldUninstaller "$agentCodeOldDir\${UNINSTALL_FILENAME}"
      ${EndIf}
      ${If} $agentCodeOldDir == ""
      ${AndIf} $agentCodeOldUninstaller != ""
        ; Sem InstallLocation: a pasta é a do desinstalador.
        ${GetParent} $agentCodeOldUninstaller $agentCodeOldDir
      ${EndIf}

      ${If} ${FileExists} $agentCodeOldUninstaller
        DetailPrint "Removendo a instalação antiga por máquina em $agentCodeOldDir"
        ; O desinstalador roda de fora da pasta (ela vai ser apagada) e elevado (UAC).
        InitPluginsDir
        StrCpy $agentCodeOldUninstallerTemp "$PLUGINSDIR\old-uninstaller.exe"
        ClearErrors
        CopyFiles /SILENT "$agentCodeOldUninstaller" "$agentCodeOldUninstallerTemp"
        ${If} ${Errors}
          DetailPrint "Não deu para copiar o desinstalador antigo; a instalação antiga fica como está."
          ClearErrors
        ${Else}
          ClearErrors
          ExecShellWait "runas" "$agentCodeOldUninstallerTemp" '/S /KEEP_APP_DATA /allusers --updated _?=$agentCodeOldDir'
          ${If} ${Errors}
            ; UAC cancelado ou execução recusada: segue sem remover.
            DetailPrint "A remoção da instalação antiga foi cancelada; ela fica para remover pelo Painel de Controle."
            ClearErrors
          ${Else}
            DetailPrint "Instalação antiga removida."
          ${EndIf}
        ${EndIf}
      ${Else}
        DetailPrint "Registro de instalação antiga sem desinstalador em disco; nada a remover."
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
