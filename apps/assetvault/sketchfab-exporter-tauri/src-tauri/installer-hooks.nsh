; The wrapper selects the existing install directory for both manual and automatic
; upgrades. Remove legacy registration/shortcuts only when they belong to it.
!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $R0 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\AssetVault" "InstallLocation"
  ${If} $R0 == $INSTDIR
    DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\AssetVault"
    DeleteRegKey SHCTX "Software\assetvault\AssetVault"
  ${EndIf}
  !insertmacro IsShortcutTarget "$DESKTOP\AssetVault.lnk" "$INSTDIR\assetvault.exe"
  Pop $R0
  ${If} $R0 == 1
    Delete "$DESKTOP\AssetVault.lnk"
  ${EndIf}
  !insertmacro IsShortcutTarget "$SMPROGRAMS\AssetVault.lnk" "$INSTDIR\assetvault.exe"
  Pop $R0
  ${If} $R0 == 1
    Delete "$SMPROGRAMS\AssetVault.lnk"
  ${EndIf}
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "Arvimo · 艺团"
!macroend
