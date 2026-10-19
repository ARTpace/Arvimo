Unicode true
ManifestDPIAware true
; Add in `dpiAwareness` `PerMonitorV2` to manifest for Windows 10 1607+ (note this should not affect lower versions since they should be able to ignore this and pick up `dpiAware` `true` set by `ManifestDPIAware true`)
; Currently undocumented on NSIS's website but is in the Docs folder of source tree, see
; https://github.com/kichik/nsis/blob/5fc0b87b819a9eec006df4967d08e522ddd651c9/Docs/src/attributes.but#L286-L300
; https://github.com/tauri-apps/tauri/pull/10106
ManifestDPIAwareness PerMonitorV2

!if "{{compression}}" == "none"
  SetCompress off
!else
  ; Set the compression algorithm. We default to LZMA.
  SetCompressor /SOLID "{{compression}}"
!endif

; Keep above !include to stay ahead of any plugin command
; see https://github.com/tauri-apps/tauri/pull/15422#discussion_r3289239624
{{#if signed_plugins_path}}
!addplugindir "{{signed_plugins_path}}"
{{/if}}

!include MUI2.nsh

; ============================================================
; Custom UI beautification (AssetVault / SimpChinese)
; ============================================================
; Prevent header/sidebar bitmaps from being stretched
!define MUI_HEADERIMAGE_BITMAP_NOSTRETCH
!define MUI_WELCOMEFINISHPAGE_BITMAP_NOSTRETCH
!define MUI_WELCOMEPAGE_TITLE_3LINES
; Custom welcome page title/text (Simplified Chinese)
!define MUI_WELCOMEPAGE_TITLE "欢迎使用 ${PRODUCTNAME}"
!define MUI_WELCOMEPAGE_TEXT "安装向导将引导您完成 \$(^Name) 的安装。$\r$\n$\r$\n点击「下一步」按钮继续安装。$\r$\n$\r$\n如果在安装过程中遇到任何问题，请关闭其他程序后重试。"
; Custom finish page title/text
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "\$(^Name) 已成功安装到您的电脑。$\r$\n$\r$\n点击「完成」按钮退出安装向导。$\r$\n$\r$\n如果勾选了「运行 \$(^Name)」，安装完成后将自动启动程序。"
!include FileFunc.nsh
!include x64.nsh
!include WordFunc.nsh
!include "utils.nsh"
!include "FileAssociation.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "Win\RestartManager.nsh"
!include "StrFunc.nsh"
${StrCase}
${StrLoc}

{{#if installer_hooks}}
!include "{{installer_hooks}}"
{{/if}}

!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define HOMEPAGE "{{homepage}}"
!define INSTALLMODE "{{install_mode}}"
!define LICENSE "{{license}}"
!define INSTALLERICON "{{installer_icon}}"
!define SIDEBARIMAGE "{{sidebar_image}}"
!define HEADERIMAGE "{{header_image}}"
!define UNINSTALLERICON "{{uninstaller_icon}}"
!define UNINSTALLERHEADERIMAGE "{{uninstaller_header_image}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define COPYRIGHT "{{copyright}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define ADDITIONALPLUGINSPATH "{{additional_plugins_path}}"
!define ALLOWDOWNGRADES "{{allow_downgrades}}"
!define DISPLAYLANGUAGESELECTOR "{{display_language_selector}}"
!define INSTALLWEBVIEW2MODE "{{install_webview2_mode}}"
!define WEBVIEW2INSTALLERARGS "{{webview2_installer_args}}"
!define WEBVIEW2BOOTSTRAPPERPATH "{{webview2_bootstrapper_path}}"
!define WEBVIEW2INSTALLERPATH "{{webview2_installer_path}}"
!define MINIMUMWEBVIEW2VERSION "{{minimum_webview2_version}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUKEY "Software\${MANUFACTURER}"
!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCTNAME}"
!define UNINSTALLERSIGNCOMMAND "{{uninstaller_sign_cmd}}"
!define ESTIMATEDSIZE "{{estimated_size}}"
!define STARTMENUFOLDER "{{start_menu_folder}}"

Var PassiveMode
Var UpdateMode
Var NoShortcutMode
Var WixMode
Var OldMainBinaryName

Name "${PRODUCTNAME}"
BrandingText " "
OutFile "${OUTFILE}"

; We don't actually use this value as default install path,
; it's just for nsis to append the product name folder in the directory selector
; https://nsis.sourceforge.io/Reference/InstallDir
!define PLACEHOLDER_INSTALL_DIR "placeholder\${PRODUCTNAME}"
InstallDir "${PLACEHOLDER_INSTALL_DIR}"

VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

# additional plugins
!addplugindir "${ADDITIONALPLUGINSPATH}"

; Uninstaller signing command
!if "${UNINSTALLERSIGNCOMMAND}" != ""
  !uninstfinalize '${UNINSTALLERSIGNCOMMAND}'
!endif

; Handle install mode, `perUser`, `perMachine` or `both`
!if "${INSTALLMODE}" == "perMachine"
  RequestExecutionLevel admin
!endif

!if "${INSTALLMODE}" == "currentUser"
  RequestExecutionLevel user
!endif

!if "${INSTALLMODE}" == "both"
  !define MULTIUSER_MUI
  !define MULTIUSER_INSTALLMODE_INSTDIR "${PRODUCTNAME}"
  !define MULTIUSER_INSTALLMODE_COMMANDLINE
  !if "${ARCH}" == "x64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !else if "${ARCH}" == "arm64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !endif
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_KEY "${UNINSTKEY}"
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_VALUENAME "CurrentUser"
  !define MULTIUSER_INSTALLMODEPAGE_SHOWUSERNAME
  !define MULTIUSER_INSTALLMODE_FUNCTION RestorePreviousInstallLocation
  !define MULTIUSER_EXECUTIONLEVEL Highest
  !include MultiUser.nsh
!endif

; Installer icon
!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
!endif

; Installer sidebar image
!if "${SIDEBARIMAGE}" != ""
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${SIDEBARIMAGE}"
!endif

; Enable header images for installer and uninstaller pages when either image is configured.
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!else if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!endif

; Installer header image
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_BITMAP "${HEADERIMAGE}"
!endif

; Uninstaller header image
!if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_UNBITMAP "${UNINSTALLERHEADERIMAGE}"
!endif

; Uninstaller icon
!if "${UNINSTALLERICON}" != ""
  !define MUI_UNICON "${UNINSTALLERICON}"
!endif

; ======== AssetVault「收纳箱」风安装界面（无边框整窗 + 手绘面板 + 胶囊按键）========
; 素材与 ${SIDEBARIMAGE} 同目录，用 \..\ 推导，跟着工程走
!macro AVArt F
  File /oname=$PLUGINSDIR\${F} "${SIDEBARIMAGE}\..\${F}"
!macroend

!define /ifndef BS_BITMAP 0x0080
!define /ifndef SS_BITMAP 0x0000000E
!define /ifndef BM_CLICK 0x00F5
!define /ifndef BM_SETIMAGE 0x00F7
!define /ifndef STM_SETIMAGE 0x0172
!define /ifndef IMAGE_BITMAP 0
!define /ifndef LR_LOADFROMFILE 0x0010
!define /ifndef LR_CREATEDIBSECTION 0x2000
!define /ifndef GWL_STYLE -16
!define /ifndef GWL_EXSTYLE -20
!define /ifndef WS_EX_APPWINDOW 0x00040000
!define /ifndef SWP_NOSIZE 0x0001
!define /ifndef SWP_NOMOVE 0x0002
!define /ifndef SWP_NOZORDER 0x0004
!define /ifndef SWP_NOACTIVATE 0x0010
!define /ifndef SWP_FRAMECHANGED 0x0020
!define /ifndef SWP_SHOWWINDOW 0x0040
!define AV_WIN_STYLE 0x82080000
!define AV_WINW 600
!define AV_WINH 380

!define MUI_CUSTOMFUNCTION_GUIINIT AVWizInit
!define MUI_BGCOLOR "FFFAF2"
!define MUI_TEXTCOLOR "5A4535"
!define MUI_INSTFILESPAGE_COLORS "5A4535 FFFAF2"
!define MUI_INSTFILESPAGE_PROGRESSBAR colored

Var AVDpi
Var AVWpx
Var AVHpx
Var AVSuf
Var AVDlg
Var AVPanel
Var AVBtnMain
Var AVBtnAlt
Var AVBtnFolder
Var AVBtnClose
Var AVChkShortcut
Var AVPath

!macro AVSc V OUT
  IntOp ${OUT} $AVDpi * ${V}
  IntOp ${OUT} ${OUT} / 96
!macroend

!macro AVSetBmpMsg CTRL FILE MSG
  System::Call 'user32::LoadImageW(i 0, t "${FILE}", i ${IMAGE_BITMAP}, i 0, i 0, i ${LR_LOADFROMFILE}|${LR_CREATEDIBSECTION}) p .r9'
  SendMessage ${CTRL} ${MSG} ${IMAGE_BITMAP} $9
  ; 位图是控件创建之后才挂上去的，不强制重绘就会出现「鼠标移上去才显示」
  System::Call 'user32::InvalidateRect(p ${CTRL}, p 0, i 1)'
  System::Call 'user32::UpdateWindow(p ${CTRL})'
!macroend

!macro AVSetBmp CTRL FILE
  !insertmacro AVSetBmpMsg ${CTRL} "${FILE}" ${STM_SETIMAGE}
!macroend

; 按钮贴位图必须用 BM_SETIMAGE，用 STM_SETIMAGE 按钮不会有任何反应
!macro AVSetBtnBmp CTRL FILE
  !insertmacro AVSetBmpMsg ${CTRL} "${FILE}" ${BM_SETIMAGE}
!macroend

; nsDialogs::CreateControl 是把新控件插到 z-order 底部的（实测：先建的整窗面板反而在最顶，
; 后建的控件全压在它下面）。面板又是不透明位图铺满全窗，于是「一个按键都看不到」
; （早期表现为鼠标悬停时被系统重绘才闪出来）。任何要露在面板上的控件都必须显式提到 HWND_TOP。
!macro AVTop CTRL
  System::Call 'user32::SetWindowPos(p ${CTRL}, i 0, i 0, i 0, i 0, i 0, i ${SWP_NOMOVE}|${SWP_NOSIZE}|${SWP_NOACTIVATE})'
!macroend

!macro AVPill CTRLVAR X Y W H BMP
  nsDialogs::CreateControl "Button" "${__NSD_Button_STYLE}|${BS_BITMAP}" 0 ${X} ${Y} ${W} ${H} ""
  Pop ${CTRLVAR}
  !insertmacro AVSetBtnBmp ${CTRLVAR} "$PLUGINSDIR\${BMP}$AVSuf.bmp"
  ShowWindow ${CTRLVAR} 5
  !insertmacro AVTop ${CTRLVAR}
!macroend

; 程序化按标准按钮。先 ShowWindow 再 BM_CLICK —— MUI 会在某些页面隐藏
; 「上一步」，而隐藏窗口上的 BM_CLICK 是否生效各 Windows 版本并不一致。
; 点下去会立刻切页，新页面的 create 会立即再把它藏起来，用户看不到闪烁。
; 注意只能「隐藏」不能「移位」：MUI 不会重置按钮位置，移位会让
; 「已装过旧版本」分支页（PageReinstall，用的还是标准按钮）永远点不到下一步。
!macro AVPress ID
  GetDlgItem $0 $HWNDPARENT ${ID}
  ShowWindow $0 5
  SendMessage $0 ${BM_CLICK} 0 0
!macroend

; 自定义页上不能露出 MUI 的标准按钮（下一步/上一步/取消）。
; 主要靠整窗面板盖住（AVFillDlg 会把 nsDialogs 对话框提到最上层），
; 这里再显式隐藏一层兜底。
!macro AVIHideStd
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 0
!macroend

; 让 nsDialogs 页面铺满整窗，否则 MUI 会把它挤在标题栏下面。
; hWndInsertAfter 传 0 就是 HWND_TOP：把对话框提到最上层，它和里面的整窗面板
; 才会盖住 MUI 的标准按钮（下一步/上一步/取消）——这三个按钮是 $HWNDPARENT 的
; 子窗口，不提到最上层就会浮在手绘面板上面。
!macro AVFillDlg
  System::Call 'user32::SetWindowPos(p $AVDlg, i 0, i 0, i 0, i $AVWpx, i $AVHpx, i ${SWP_SHOWWINDOW})'
  nsDialogs::CreateControl "Static" "${__NSD_Label_STYLE}|${SS_BITMAP}" 0 0 0 $AVWpx $AVHpx ""
  Pop $AVPanel
  ; 面板显式沉到最底（HWND_BOTTOM=1），保证它永远垫在所有胶囊按键下面。
  System::Call 'user32::SetWindowPos(p $AVPanel, i 1, i 0, i 0, i 0, i 0, i ${SWP_NOMOVE}|${SWP_NOSIZE}|${SWP_NOACTIVATE})'
!macroend

; Define registry key to store installer language
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${MANUPRODUCTKEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"

; Installer pages, must be ordered as they appear
; 1. Welcome Page（自定义整窗面板）
Page custom AVWelcomeCreate

; 2. License Page (if defined)
!if "${LICENSE}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MUI_PAGE_LICENSE "${LICENSE}"
!endif

; 3. Install mode (if it is set to `both`)
!if "${INSTALLMODE}" == "both"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MULTIUSER_PAGE_INSTALLMODE
!endif

; 4. Custom page to ask user if he wants to reinstall/uninstall
;    only if a previous installation was detected
Var ReinstallPageCheck
Page custom PageReinstall PageLeaveReinstall
Function PageReinstall
  ; Uninstall previous WiX installation if exists.
  ;
  ; A WiX installer stores the installation info in registry
  ; using a UUID and so we have to loop through all keys under
  ; `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
  ; and check if `DisplayName` and `Publisher` keys match ${PRODUCTNAME} and ${MANUFACTURER}
  ;
  ; This has a potential issue that there maybe another installation that matches
  ; our ${PRODUCTNAME} and ${MANUFACTURER} but wasn't installed by our WiX installer,
  ; however, this should be fine since the user will have to confirm the uninstallation
  ; and they can chose to abort it if doesn't make sense.
  StrCpy $0 0
  wix_loop:
    EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" wix_loop_done ; Exit loop if there is no more keys to loop on
    IntOp $0 $0 + 1
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
    StrCmp "$R0$R1" "${PRODUCTNAME}${MANUFACTURER}" 0 wix_loop
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    ${StrCase} $R1 $R0 "L"
    ${StrLoc} $R0 $R1 "msiexec" ">"
    StrCmp $R0 0 0 wix_loop_done
    StrCpy $WixMode 1
    StrCpy $R6 "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1"
    Goto compare_version
  wix_loop_done:

  ; Check if there is an existing installation, if not, abort the reinstall page
  ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${IfThen} "$R0$R1" == "" ${|} Abort ${|}

  ; Compare this installar version with the existing installation
  ; and modify the messages presented to the user accordingly
  compare_version:
  StrCpy $R4 "$(older)"
  ${If} $WixMode = 1
    ReadRegStr $R0 HKLM "$R6" "DisplayVersion"
  ${Else}
    ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${EndIf}
  ${IfThen} $R0 == "" ${|} StrCpy $R4 "$(unknown)" ${|}

  nsis_tauri_utils::SemverCompare "${VERSION}" $R0
  Pop $R0
  ; Reinstalling the same version
  ${If} $R0 = 0
    StrCpy $R1 "$(alreadyInstalledLong)"
    StrCpy $R2 "$(addOrReinstall)"
    StrCpy $R3 "$(uninstallApp)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(chooseMaintenanceOption)"
  ; Upgrading
  ${ElseIf} $R0 = 1
    StrCpy $R1 "$(olderOrUnknownVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    StrCpy $R3 "$(dontUninstall)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(choowHowToInstall)"
  ; Downgrading
  ${ElseIf} $R0 = -1
    StrCpy $R1 "$(newerVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    !if "${ALLOWDOWNGRADES}" == "true"
      StrCpy $R3 "$(dontUninstall)"
    !else
      StrCpy $R3 "$(dontUninstallDowngrade)"
    !endif
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(choowHowToInstall)"
  ${Else}
    Abort
  ${EndIf}

  ; Skip showing the page if passive
  ;
  ; Note that we don't call this earlier at the beginning
  ; of this function because we need to populate some variables
  ; related to current installed version if detected and whether
  ; we are downgrading or not.
  ${If} $PassiveMode = 1
    Call PageLeaveReinstall
  ${Else}
    nsDialogs::Create 1018
    Pop $R4
    ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}

    ${NSD_CreateLabel} 0 0 100% 24u $R1
    Pop $R1

    ${NSD_CreateRadioButton} 30u 50u -30u 8u $R2
    Pop $R2
    ${NSD_OnClick} $R2 PageReinstallUpdateSelection

    ${NSD_CreateRadioButton} 30u 70u -30u 8u $R3
    Pop $R3
    ; Disable this radio button if downgrading and downgrades are disabled
    !if "${ALLOWDOWNGRADES}" == "false"
      ${IfThen} $R0 = -1 ${|} EnableWindow $R3 0 ${|}
    !endif
    ${NSD_OnClick} $R3 PageReinstallUpdateSelection

    ; Check the first radio button if this the first time
    ; we enter this page or if the second button wasn't
    ; selected the last time we were on this page
    ${If} $ReinstallPageCheck <> 2
      SendMessage $R2 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${Else}
      SendMessage $R3 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${EndIf}

    ${NSD_SetFocus} $R2
    nsDialogs::Show
  ${EndIf}
FunctionEnd
Function PageReinstallUpdateSelection
  ${NSD_GetState} $R2 $R1
  ${If} $R1 == ${BST_CHECKED}
    StrCpy $ReinstallPageCheck 1
  ${Else}
    StrCpy $ReinstallPageCheck 2
  ${EndIf}
FunctionEnd
Function PageLeaveReinstall
  ${NSD_GetState} $R2 $R1

  ; If migrating from Wix, always uninstall
  ${If} $WixMode = 1
    Goto reinst_uninstall
  ${EndIf}

  ; In update mode, always proceeds without uninstalling
  ${If} $UpdateMode = 1
    Goto reinst_done
  ${EndIf}

  ; $R0 holds whether same(0)/upgrading(1)/downgrading(-1) version
  ; $R1 holds the radio buttons state:
  ;   1 => first choice was selected
  ;   0 => second choice was selected
  ${If} $R0 = 0 ; Same version, proceed
    ${If} $R1 = 1              ; User chose to add/reinstall
      Goto reinst_done
    ${Else}                    ; User chose to uninstall
      Goto reinst_uninstall
    ${EndIf}
  ${ElseIf} $R0 = 1 ; Upgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${ElseIf} $R0 = -1 ; Downgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${EndIf}

  reinst_uninstall:
    HideWindow
    ClearErrors

    ${If} $WixMode = 1
      ReadRegStr $R1 HKLM "$R6" "UninstallString"
      ExecWait '$R1' $0
    ${Else}
      ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
      ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
      ${IfThen} $UpdateMode = 1 ${|} StrCpy $R1 "$R1 /UPDATE" ${|} ; append /UPDATE
      ${IfThen} $PassiveMode = 1 ${|} StrCpy $R1 "$R1 /P" ${|} ; append /P
      StrCpy $R1 "$R1 _?=$4" ; append uninstall directory
      ExecWait '$R1' $0
    ${EndIf}

    BringToFront

    ${IfThen} ${Errors} ${|} StrCpy $0 2 ${|} ; ExecWait failed, set fake exit code

    ${If} $0 <> 0
    ${OrIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ; User cancelled wix uninstaller? return to select un/reinstall page
      ${If} $WixMode = 1
      ${AndIf} $0 = 1602
        Abort
      ${EndIf}

      ; User cancelled NSIS uninstaller? return to select un/reinstall page
      ${If} $0 = 1
        Abort
      ${EndIf}

      ; Other errors? show generic error message and return to select un/reinstall page
      MessageBox MB_ICONEXCLAMATION "$(unableToUninstall)"
      Abort
    ${EndIf}

    ; The NSIS uninstaller was run in place (`_?=`), so it cannot delete itself
    ; and the install directory, clean them up here once the uninstall succeeded
    ; https://nsis.sourceforge.io/Docs/Chapter3.html#:~:text=path%20contains%20spaces.-,3.2.3%20Examples,-installer.exe%20/NCRC
    ${If} $WixMode = 0
    ${AndIf} $4 != ""
      Delete "$4\uninstall.exe"
      RMDir "$4"
    ${EndIf}
  reinst_done:
FunctionEnd

; 5. Choose install directory page（自定义，用系统选目录对话框）
Page custom AVFolderCreate

; 6. Start menu shortcut page
Var AppStartMenuFolder
!if "${STARTMENUFOLDER}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !define MUI_STARTMENUPAGE_DEFAULTFOLDER "${STARTMENUFOLDER}"
!else
  !define MUI_PAGE_CUSTOMFUNCTION_PRE Skip
!endif
!insertmacro MUI_PAGE_STARTMENU Application $AppStartMenuFolder

; 7. Installation page（自定义整窗面板 + 染色进度条）
!define MUI_PAGE_CUSTOMFUNCTION_SHOW AVInstallShow
!insertmacro MUI_PAGE_INSTFILES

; 8. Finish page（自定义整窗面板）
; 不再用 MUI_FINISHPAGE_NOAUTOCLOSE：安装页的按钮被隐藏了，靠自动跳转进入完成页
Page custom AVFinishCreate

Function RunMainBinary
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
FunctionEnd

; ======== 收纳箱风界面：窗口与自定义页面 ========

; 输入 $R0 = 控件 ID -> 输出 $R1 = 句柄（先查主窗口，再查各子页面）
Function AVFindCtl
  GetDlgItem $R1 $HWNDPARENT $R0
  StrCmp $R1 0 0 avfinddone
  StrCpy $2 0
avfindloop:
  System::Call 'user32::FindWindowExW(p $HWNDPARENT, p $2, i 0, i 0) p .r2'
  StrCmp $2 0 avfinddone
  GetDlgItem $R1 $2 $R0
  StrCmp $R1 0 avfindloop
avfinddone:
FunctionEnd

; 去掉标题栏、固定尺寸、圆角
Function AVWizInit
  ; $AVDpi 存的不是真实 DPI，而是「素材设计 DPI」。素材只有 1x(600x380) 和 1.5x(900x570)
  ; 两套，窗口尺寸必须和位图尺寸严格一致 —— 否则位图盖不到的地方会露出一条白底，
  ; 也就是「图片边缘有多余的白边」。所以按真实 DPI 选一档设计尺寸，
  ; 再拿它去算窗口与所有控件坐标，两边永远对得上（125%/150%/200% 一律吃 1.5x）。
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i .r2'
  StrCpy $AVDpi 96
  StrCpy $AVSuf ""
  IntCmp $2 120 avwiz_15 avwiz_sz avwiz_15
avwiz_15:
  StrCpy $AVDpi 144
  StrCpy $AVSuf "@2x"
avwiz_sz:
  !insertmacro AVSc ${AV_WINW} $AVWpx
  !insertmacro AVSc ${AV_WINH} $AVHpx
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i ${GWL_STYLE}, i ${AV_WIN_STYLE})'
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i ${GWL_EXSTYLE}) i .r8'
  IntOp $8 $8 | ${WS_EX_APPWINDOW}
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i ${GWL_EXSTYLE}, i $8)'
  System::Call 'user32::GetSystemMetrics(i 0) i .r5'
  System::Call 'user32::GetSystemMetrics(i 1) i .r6'
  IntOp $5 $5 - $AVWpx
  IntOp $5 $5 / 2
  IntOp $6 $6 - $AVHpx
  IntOp $6 $6 / 2
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, i 0, i $5, i $6, i $AVWpx, i $AVHpx, i ${SWP_FRAMECHANGED}|${SWP_SHOWWINDOW})'
  ; 注意：CreateRoundRectRgn 最后两个参数是「椭圆宽高」不是半径，想要 R 得传 2R
  !insertmacro AVSc 26 $3
  IntOp $3 $3 * 2
  System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i $AVWpx, i $AVHpx, i $3, i $3) p .r7'
  System::Call 'user32::SetWindowRgn(p $HWNDPARENT, p $7, i 1)'
FunctionEnd

; ---- 1. 欢迎页 ----
Function AVWelcomeCreate
  Call SkipIfPassive
  !insertmacro AVIHideStd
  nsDialogs::Create 1018
  Pop $AVDlg
  StrCmp $AVDlg error 0 +2
    Abort
  !insertmacro AVFillDlg
  !insertmacro AVSetBmp $AVPanel "$PLUGINSDIR\win-welcome$AVSuf.bmp"
  !insertmacro AVSc 210 $1
  !insertmacro AVSc 292 $2
  !insertmacro AVSc 180 $3
  !insertmacro AVSc 46 $4
  !insertmacro AVPill $AVBtnMain $1 $2 $3 $4 "wbtn-start"
  !insertmacro AVSc 402 $1
  !insertmacro AVPill $AVBtnAlt $1 $2 $3 $4 "wbtn-later"
  ; 右上角关闭钮：窗口没有标题栏，这是用户唯一的「关掉它」入口
  !insertmacro AVSc 540 $1
  !insertmacro AVSc 16 $2
  !insertmacro AVSc 30 $3
  !insertmacro AVSc 30 $4
  !insertmacro AVPill $AVBtnClose $1 $2 $3 $4 "wbtn-close"
  ${NSD_OnClick} $AVBtnMain AVGoNext
  ${NSD_OnClick} $AVBtnAlt AVGoCancel
  ${NSD_OnClick} $AVBtnClose AVGoCancel
  nsDialogs::Show
FunctionEnd

Function AVGoNext
  !insertmacro AVPress 1
FunctionEnd

Function AVGoCancel
  !insertmacro AVPress 2
FunctionEnd

Function AVGoBack
  !insertmacro AVPress 3
FunctionEnd

; ---- 5. 安装位置页 ----
Function AVFolderCreate
  Call SkipIfPassive
  !insertmacro AVIHideStd
  nsDialogs::Create 1018
  Pop $AVDlg
  StrCmp $AVDlg error 0 +2
    Abort
  !insertmacro AVFillDlg
  !insertmacro AVSetBmp $AVPanel "$PLUGINSDIR\win-folder$AVSuf.bmp"
  !insertmacro AVSc 300 $1
  !insertmacro AVSc 196 $2
  !insertmacro AVSc 272 $3
  !insertmacro AVSc 20 $4
  ${NSD_CreateLabel} $1 $2 $3 $4 "$INSTDIR"
  Pop $AVPath
  ; 不能用 transparent：它会向父对话框擦背景，而对话框底色是系统灰，
  ; 奶油面板上就会出现一块灰底文字。这里取面板同处像素的实色（F5FBF4）。
  SetCtlColors $AVPath "8A6A50" "F5FBF4"
  !insertmacro AVTop $AVPath
  !insertmacro AVSc 300 $1
  !insertmacro AVSc 226 $2
  !insertmacro AVSc 150 $3
  !insertmacro AVSc 36 $4
  !insertmacro AVPill $AVBtnFolder $1 $2 $3 $4 "wbtn-folder"
  ${NSD_OnClick} $AVBtnFolder AVPickFolder
  !insertmacro AVSc 210 $1
  !insertmacro AVSc 292 $2
  !insertmacro AVSc 180 $3
  !insertmacro AVSc 46 $4
  !insertmacro AVPill $AVBtnMain $1 $2 $3 $4 "wbtn-start"
  !insertmacro AVSc 402 $1
  !insertmacro AVPill $AVBtnAlt $1 $2 $3 $4 "wbtn-back"
  ; 右上角关闭钮（同欢迎页）
  !insertmacro AVSc 540 $1
  !insertmacro AVSc 16 $2
  !insertmacro AVSc 30 $3
  !insertmacro AVSc 30 $4
  !insertmacro AVPill $AVBtnClose $1 $2 $3 $4 "wbtn-close"
  ${NSD_OnClick} $AVBtnMain AVGoNext
  ${NSD_OnClick} $AVBtnAlt AVGoBack
  ${NSD_OnClick} $AVBtnClose AVGoCancel
  nsDialogs::Show
FunctionEnd

Function AVPickFolder
  nsDialogs::SelectFolderDialog "给 AssetVault 选个安家的位置" "$INSTDIR"
  Pop $0
  StrCmp $0 error 0 +2
    Return
  StrCmp $0 "" 0 +2
    Return
  StrCpy $INSTDIR $0
  ${NSD_SetText} $AVPath "$INSTDIR"
FunctionEnd

; ---- 7. 安装页 ----
Function AVInstallShow
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 0
  ; 整窗面板（盖住 MUI 标题栏、水印、状态文字）
  System::Call 'user32::CreateWindowExW(i 0, w "Static", w "", i 0x5000000E, i 0, i 0, i $AVWpx, i $AVHpx, p $HWNDPARENT, i 0, i 0, i 0) p .r1'
  System::Call 'user32::LoadImageW(i 0, t "$PLUGINSDIR\win-install$AVSuf.bmp", i ${IMAGE_BITMAP}, i 0, i 0, i ${LR_LOADFROMFILE}|${LR_CREATEDIBSECTION}) p .r2'
  SendMessage $1 ${STM_SETIMAGE} ${IMAGE_BITMAP} $2
  ; 进度条原本在 MUI 的页面子窗口里（会被面板盖住），先挂到主窗口再摆位
  StrCpy $R0 1004
  Call AVFindCtl
  System::Call 'user32::SetParent(p $R1, p $HWNDPARENT)'
  !insertmacro AVSc 302 $4
  !insertmacro AVSc 224 $5
  !insertmacro AVSc 250 $6
  !insertmacro AVSc 14 $7
  System::Call 'user32::SetWindowPos(p $R1, i 0, i $4, i $5, i $6, i $7, i ${SWP_SHOWWINDOW})'
  System::Call 'uxtheme::SetWindowTheme(p $R1, w "", w "")'
  SendMessage $R1 0x2001 0 0x00DEF0FF
  SendMessage $R1 0x0409 0 0x0058B0F6
  ; 状态文字隐藏（面板上已经有文案）
  StrCpy $R0 1006
  Call AVFindCtl
  ShowWindow $R1 0
  System::Call 'user32::InvalidateRect(p $1, p 0, i 1)'
  System::Call 'user32::UpdateWindow(p $1)'
  ; 取消按钮挪到卡片右下角并换成手绘胶囊（保留一条退路，但风格要统一）。
  ; 尺寸按素材 150x36 精确对齐，@2x 时正好 225x54，不会被裁边。
  StrCpy $R0 2
  Call AVFindCtl
  !insertmacro AVSc 424 $4
  !insertmacro AVSc 322 $5
  !insertmacro AVSc 150 $6
  !insertmacro AVSc 36 $7
  System::Call 'user32::SetWindowPos(p $R1, i 0, i $4, i $5, i $6, i $7, i ${SWP_SHOWWINDOW})'
  System::Call 'user32::GetWindowLongW(p $R1, i ${GWL_STYLE}) i .r3'
  IntOp $3 $3 | ${BS_BITMAP}
  System::Call 'user32::SetWindowLongW(p $R1, i ${GWL_STYLE}, i $3)'
  System::Call 'uxtheme::SetWindowTheme(p $R1, w "", w "")'
  System::Call 'user32::SetWindowPos(p $R1, i 0, i 0, i 0, i 0, i 0, i ${SWP_NOMOVE}|${SWP_NOSIZE}|${SWP_NOZORDER}|${SWP_FRAMECHANGED})'
  !insertmacro AVSetBtnBmp $R1 "$PLUGINSDIR\wbtn-cancel$AVSuf.bmp"
FunctionEnd

; ---- 8. 完成页 ----
Function AVFinishCreate
  Call SkipIfPassive
  !insertmacro AVIHideStd
  nsDialogs::Create 1018
  Pop $AVDlg
  StrCmp $AVDlg error 0 +2
    Abort
  !insertmacro AVFillDlg
  !insertmacro AVSetBmp $AVPanel "$PLUGINSDIR\win-finish$AVSuf.bmp"
  !insertmacro AVSc 298 $1
  !insertmacro AVSc 226 $2
  !insertmacro AVSc 290 $3
  !insertmacro AVSc 22 $4
  ${NSD_CreateCheckBox} $1 $2 $3 $4 "顺便在桌面放一个快捷方式"
  Pop $AVChkShortcut
  SetCtlColors $AVChkShortcut "5A4535" "F4FBF4"
  !insertmacro AVTop $AVChkShortcut
  ${NSD_SetState} $AVChkShortcut ${BST_CHECKED}
  !insertmacro AVSc 210 $1
  !insertmacro AVSc 292 $2
  !insertmacro AVSc 180 $3
  !insertmacro AVSc 46 $4
  !insertmacro AVPill $AVBtnMain $1 $2 $3 $4 "wbtn-run"
  !insertmacro AVSc 402 $1
  !insertmacro AVPill $AVBtnAlt $1 $2 $3 $4 "wbtn-done"
  ; 右上角关闭钮（这一页按 × 等于「完成」，先落盘快捷方式再退出）
  !insertmacro AVSc 540 $1
  !insertmacro AVSc 16 $2
  !insertmacro AVSc 30 $3
  !insertmacro AVSc 30 $4
  !insertmacro AVPill $AVBtnClose $1 $2 $3 $4 "wbtn-close"
  ${NSD_OnClick} $AVBtnMain AVFinishRun
  ${NSD_OnClick} $AVBtnAlt AVFinishDone
  ${NSD_OnClick} $AVBtnClose AVFinishDone
  nsDialogs::Show
FunctionEnd

Function AVFinishShortcut
  StrCmp $AVChkShortcut "" 0 +2
    Return
  ${NSD_GetState} $AVChkShortcut $0
  ${If} $0 == ${BST_CHECKED}
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}
FunctionEnd

Function AVFinishRun
  Call AVFinishShortcut
  Call RunMainBinary
  !insertmacro AVPress 1
FunctionEnd

Function AVFinishDone
  Call AVFinishShortcut
  !insertmacro AVPress 1
FunctionEnd

; Uninstaller Pages
; 1. Confirm uninstall page
Var DeleteAppDataCheckbox
Var DeleteAppDataCheckboxState
!define /ifndef WS_EX_LAYOUTRTL         0x00400000
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ConfirmShow
Function un.ConfirmShow ; Add add a `Delete app data` check box
  ; $1 inner dialog HWND
  ; $2 window DPI
  ; $3 style
  ; $4 x
  ; $5 y
  ; $6 width
  ; $7 height
  FindWindow $1 "#32770" "" $HWNDPARENT ; Find inner dialog
  System::Call "user32::GetDpiForWindow(p r1) i .r2"
  ${If} $(^RTL) = 1
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE} | ${WS_EX_LAYOUTRTL}"
    IntOp $4 50 * $2
  ${Else}
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE}"
    IntOp $4 0 * $2
  ${EndIf}
  IntOp $5 100 * $2
  IntOp $6 400 * $2
  IntOp $7 25 * $2
  IntOp $4 $4 / 96
  IntOp $5 $5 / 96
  IntOp $6 $6 / 96
  IntOp $7 $7 / 96
  System::Call 'user32::CreateWindowEx(i r3, w "${__NSD_CheckBox_CLASS}", w "$(deleteAppData)", i ${__NSD_CheckBox_STYLE}, i r4, i r5, i r6, i r7, p r1, i0, i0, i0) i .s'
  Pop $DeleteAppDataCheckbox
  SendMessage $HWNDPARENT ${WM_GETFONT} 0 0 $1
  SendMessage $DeleteAppDataCheckbox ${WM_SETFONT} $1 1
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.ConfirmLeave
Function un.ConfirmLeave
  SendMessage $DeleteAppDataCheckbox ${BM_GETCHECK} 0 0 $DeleteAppDataCheckboxState
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.SkipIfPassive
!insertmacro MUI_UNPAGE_CONFIRM

; 2. Uninstalling Page
!insertmacro MUI_UNPAGE_INSTFILES

;Languages
{{#each languages}}
!insertmacro MUI_LANGUAGE "{{this}}"
{{/each}}
!insertmacro MUI_RESERVEFILE_LANGDLL
{{#each language_files}}
  !include "{{this}}"
{{/each}}

Function .onInit
  ; 安装界面素材全部解到 $PLUGINSDIR（安装结束系统自动清掉）
  InitPluginsDir
  !insertmacro AVArt splash.bmp
  !insertmacro AVArt win-welcome.bmp
  !insertmacro AVArt win-welcome@2x.bmp
  !insertmacro AVArt win-folder.bmp
  !insertmacro AVArt win-folder@2x.bmp
  !insertmacro AVArt win-install.bmp
  !insertmacro AVArt win-install@2x.bmp
  !insertmacro AVArt win-finish.bmp
  !insertmacro AVArt win-finish@2x.bmp
  !insertmacro AVArt wbtn-start.bmp
  !insertmacro AVArt wbtn-start@2x.bmp
  !insertmacro AVArt wbtn-later.bmp
  !insertmacro AVArt wbtn-later@2x.bmp
  !insertmacro AVArt wbtn-run.bmp
  !insertmacro AVArt wbtn-run@2x.bmp
  !insertmacro AVArt wbtn-done.bmp
  !insertmacro AVArt wbtn-done@2x.bmp
  !insertmacro AVArt wbtn-back.bmp
  !insertmacro AVArt wbtn-back@2x.bmp
  !insertmacro AVArt wbtn-folder.bmp
  !insertmacro AVArt wbtn-folder@2x.bmp
  !insertmacro AVArt wbtn-cancel.bmp
  !insertmacro AVArt wbtn-cancel@2x.bmp
  !insertmacro AVArt wbtn-close.bmp
  !insertmacro AVArt wbtn-close@2x.bmp
  advsplash::show 1600 420 420 -1 $PLUGINSDIR\splash.bmp
  Pop $0

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/NS" $NoShortcutMode
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
    !insertmacro MUI_LANGDLL_DISPLAY
  !endif

  !insertmacro SetContext

  ${If} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"
    ; Set default install location
    !if "${INSTALLMODE}" == "perMachine"
      ${If} ${RunningX64}
        !if "${ARCH}" == "x64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else if "${ARCH}" == "arm64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else
          StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
        !endif
      ${Else}
        StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
      ${EndIf}
    !else if "${INSTALLMODE}" == "currentUser"
      StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    !endif

    Call RestorePreviousInstallLocation
  ${EndIf}


  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_INIT
  !endif

  ; Abort downgrades if they are disabled, in the modes that skip the reinstall page choice:
  ; silent, passive and update
  !if "${ALLOWDOWNGRADES}" == "false"
  ${If} ${Silent}
  ${OrIf} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"
    nsis_tauri_utils::SemverCompare "${VERSION}" $R0
    Pop $R0
    ; If downgrading
    ${If} $R0 = -1
      ${If} ${Silent}
        System::Call 'kernel32::AttachConsole(i -1)i.r0'
        ${If} $0 <> 0
          System::Call 'kernel32::GetStdHandle(i -11)i.r0'
          System::call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)' ; set red color
          FileWrite $0 "$(silentDowngrades)"
        ${EndIf}
      ${Else}
        MessageBox MB_ICONSTOP "$(silentDowngrades)"
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}
  !endif
FunctionEnd

Section WebView2
  ; Check if Webview2 is already installed and skip this section
  ${If} ${RunningX64}
    ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr $4 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
    ReadRegStr $4 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}

  ${If} $4 == ""
    ; Webview2 installation
    ;
    ; Skip if updating
    ${If} $UpdateMode <> 1
      !if "${INSTALLWEBVIEW2MODE}" == "downloadBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        DetailPrint "$(webview2Downloading)"
        NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Pop $0
        ${If} $0 == "success"
          DetailPrint "$(webview2DownloadSuccess)"
        ${Else}
          DetailPrint "$(webview2DownloadError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "embedBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebview2Setup.exe" "${WEBVIEW2BOOTSTRAPPERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "offlineInstaller"
        Delete "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        Goto install_webview2
      !endif

      Goto webview2_done

      install_webview2:
        DetailPrint "$(installingWebview2)"
        ; $6 holds the path to the webview2 installer
        ExecWait "$6 ${WEBVIEW2INSTALLERARGS} /install" $1
        ${If} $1 = 0
          DetailPrint "$(webview2InstallSuccess)"
        ${Else}
          DetailPrint "$(webview2InstallError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
      webview2_done:
    ${EndIf}
  ${Else}
    !if "${MINIMUMWEBVIEW2VERSION}" != ""
      ${VersionCompare} "${MINIMUMWEBVIEW2VERSION}" "$4" $R0
      ${If} $R0 = 1
        update_webview:
          DetailPrint "$(installingWebview2)"
          ${If} ${RunningX64}
            ReadRegStr $R1 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate" "path"
          ${Else}
            ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 == ""
            ReadRegStr $R1 HKCU "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 != ""
            ; Chromium updater docs: https://source.chromium.org/chromium/chromium/src/+/main:docs/updater/user_manual.md
            ; Modified from "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView\ModifyPath"
            ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1
            ${If} $1 = 0
              DetailPrint "$(webview2InstallSuccess)"
            ${Else}
              MessageBox MB_ICONEXCLAMATION|MB_ABORTRETRYIGNORE "$(webview2InstallError)" IDIGNORE ignore IDRETRY update_webview
              Quit
              ignore:
            ${EndIf}
          ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
SectionEnd

Section Install
  SetOutPath $INSTDIR

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Copy main executable
  File "${MAINBINARYSRCPATH}"

  ; Copy resources
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
  {{/each}}

  ; Copy external binaries
  {{#each binaries}}
    File /a "/oname={{this}}" "{{no-escape @key}}"
  {{/each}}

  ; Create file associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
       !insertmacro APP_ASSOCIATE "{{ext}}" "{{or association.name ext}}" "{{association-description association.description ext}}" "$INSTDIR\${MAINBINARYNAME}.exe,0" "Open with ${PRODUCTNAME}" "$INSTDIR\${MAINBINARYNAME}.exe $\"%1$\""
    {{/each}}
  {{/each}}

  ; Register deep links
  {{#each deep_link_protocols as |protocol| ~}}
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "" "URL:${BUNDLEID} protocol"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  {{/each}}

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Save $INSTDIR in registry for future installations
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR

  !if "${INSTALLMODE}" == "both"
    ; Save install mode to be selected by default for the next installation such as updating
    ; or when uninstalling
    WriteRegStr SHCTX "${UNINSTKEY}" $MultiUser.InstallMode 1
  !endif

  ; Remove old main binary if it doesn't match new main binary name
  ReadRegStr $OldMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $OldMainBinaryName != ""
  ${AndIf} $OldMainBinaryName != "${MAINBINARYNAME}.exe"
    Delete "$INSTDIR\$OldMainBinaryName"
  ${EndIf}

  ; Save current MAINBINARYNAME for future updates
  WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "${MAINBINARYNAME}.exe"

  ; Registry information for add/remove programs
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" "1"

  ${GetSize} "$INSTDIR" "/M=uninstall.exe /S=0K /G=0" $0 $1 $2
  IntOp $0 $0 + ${ESTIMATEDSIZE}
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"

  !if "${HOMEPAGE}" != ""
    WriteRegStr SHCTX "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "URLUpdateInfo" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  !endif

  ; Create start menu shortcut
  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    Call CreateOrUpdateStartMenuShortcut
  !insertmacro MUI_STARTMENU_WRITE_END

  ; Create desktop shortcut for silent and passive installers
  ; because finish page will be skipped
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTINSTALL
    !insertmacro NSIS_HOOK_POSTINSTALL
  !endif

  ; Auto close this page for passive mode
  ${If} $PassiveMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function .onInstSuccess
  ; Check for `/R` flag only in silent and passive installers because
  ; GUI installer has a toggle for the user to (re)start the app
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/ARGS" $R0
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "$R0"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetContext

  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_UNINIT
  !endif

  !insertmacro MUI_UNGETLANGUAGE

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd

Section Uninstall

  !ifmacrodef NSIS_HOOK_PREUNINSTALL
    !insertmacro NSIS_HOOK_PREUNINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Delete the app directory and its content from disk
  ; Copy main executable
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Delete resources
  {{#each resources}}
    Delete "$INSTDIR\\{{this.[1]}}"
  {{/each}}

  ; Delete external binaries
  {{#each binaries}}
    Delete "$INSTDIR\\{{this}}"
  {{/each}}

  ; Delete app associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
      !insertmacro APP_UNASSOCIATE "{{ext}}" "{{or association.name ext}}"
    {{/each}}
  {{/each}}

  ; Delete deep links
  {{#each deep_link_protocols as |protocol| ~}}
    ReadRegStr $R7 SHCTX "Software\Classes\\{{protocol}}\shell\open\command" ""
    ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
      DeleteRegKey SHCTX "Software\Classes\\{{protocol}}"
    ${EndIf}
  {{/each}}


  ; Delete uninstaller
  Delete "$INSTDIR\uninstall.exe"

  {{#each resources_ancestors}}
  RMDir /REBOOTOK "$INSTDIR\\{{this}}"
  {{/each}}
  RMDir "$INSTDIR"

  ; Remove shortcuts if not updating
  ${If} $UpdateMode <> 1
    !insertmacro DeleteAppUserModelId

    ; Remove start menu shortcut
    !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
    !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      RMDir "$SMPROGRAMS\$AppStartMenuFolder"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; Remove desktop shortcuts
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}

  ; Remove registry information for add/remove programs
  !if "${INSTALLMODE}" == "both"
    DeleteRegKey SHCTX "${UNINSTKEY}"
  !else if "${INSTALLMODE}" == "perMachine"
    DeleteRegKey HKLM "${UNINSTKEY}"
  !else
    DeleteRegKey HKCU "${UNINSTKEY}"
  !endif

  ; Removes the Autostart entry for ${PRODUCTNAME} from the HKCU Run key if it exists.
  ; This ensures the program does not launch automatically after uninstallation if it exists.
  ; If it doesn't exist, it does nothing.
  ; We do this when not updating (to preserve the registry value on updates)
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  ${EndIf}

  ; Delete app data if the checkbox is selected
  ; and if not updating
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Clear the install location $INSTDIR from registry
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"

    ; Clear the install language from registry
    DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
    DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"

    SetShellVarContext current
    RmDir /r "$APPDATA\${BUNDLEID}"
    RmDir /r "$LOCALAPPDATA\${BUNDLEID}"
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTUNINSTALL
    !insertmacro NSIS_HOOK_POSTUNINSTALL
  !endif

  ; Auto close if passive mode or updating
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function RestorePreviousInstallLocation
  ; 兼顾 perMachine(HKLM) 与 perUser/currentUser(HKCU) 两种上下文：
  ; 优先读当前上下文，找不到再回退到另一上下文，
  ; 这样无论上一次装在 Program Files 还是 AppData，都能定位并覆盖安装。
  ReadRegStr $4 HKLM "${MANUPRODUCTKEY}" ""
  StrCmp $4 "" 0 +2
    ReadRegStr $4 HKCU "${MANUPRODUCTKEY}" ""
  StrCmp $4 "" +2 0
    StrCpy $INSTDIR $4
FunctionEnd

Function Skip
  Abort
FunctionEnd

Function SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd
Function un.SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd

Function CreateOrUpdateStartMenuShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  StrCpy $R0 0

  !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  ${If} $R0 = 1
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  !if "${STARTMENUFOLDER}" != ""
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif
FunctionEnd

Function CreateOrUpdateDesktopShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd
