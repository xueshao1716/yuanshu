; 元枢离线全量安装包（NSIS 3，Unicode，免管理员）
; 由 installer/build.mjs 调用：makensis -DSTAGE=... -DVERSION=... -DOUTFILE=... yuanshu.nsi
; 测试用命令行开关：/NOTASK 不注册自启任务、不启动服务（避免与开发机上的服务冲突）
Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!include "MUI2.nsh"
!include "FileFunc.nsh"
!ifndef ESTSIZE_KB
  !define ESTSIZE_KB 0
!endif
!include "LogicLib.nsh"

!ifndef STAGE
  !error "需要 -DSTAGE=<展开目录>"
!endif
!define APPNAME "元枢"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Yuanshu"

Name "${APPNAME} ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Yuanshu"
InstallDirRegKey HKCU "Software\Yuanshu" "InstallDir"
BrandingText "元枢 · 小语 AI 工作台"

!define MUI_ICON "${STAGE}\launcher\yuanshu.ico"
!define MUI_UNICON "${STAGE}\launcher\yuanshu.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "安装 元枢 ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "元枢是小语的工作台。$\r$\n$\r$\n这是离线全量安装包：Node.js、Python（含文档/表格/PPT/图片处理库与抠图模型）、ffmpeg、Git Bash、pi 与 dsh 引擎都已打包，不需要联网，也不需要另装任何软件。$\r$\n$\r$\n安装不需要管理员权限。使用时需要你自己的模型服务 API Key。"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "打开元枢"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchYuanshu
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION ShowGuide
!define MUI_FINISHPAGE_SHOWREADME_TEXT "查看「开始使用」说明"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

VIProductVersion "0.0.0.0"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "ProductName" "元枢"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "FileDescription" "元枢离线安装包"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_SIMPCHINESE} "LegalCopyright" "元枢开源项目"

Var NoTask

; 停掉本安装目录里正在跑的服务进程（升级/卸载前），不碰别处的 node
; 只动「属于本安装目录」的计划任务与进程：同一台机器上可能还有源码版元枢在跑（同名任务 yuanshu-watchdog），不能误伤
!define OWN_TASK `$$t = Get-ScheduledTask -TaskName yuanshu-watchdog -ErrorAction SilentlyContinue; $$own = $$t -and ($$t.Actions | Where-Object { $$_.Execute -like '$INSTDIR\*' })`
!macro StopService
  nsExec::Exec `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${OWN_TASK}; if ($$own) { Stop-ScheduledTask -TaskName yuanshu-watchdog }"`
  nsExec::Exec `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '$INSTDIR\runtime\*' } | Stop-Process -Force"`
  Sleep 1500
!macroend

Function .onInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/NOTASK" $R1
  ${IfNot} ${Errors}
    StrCpy $NoTask "1"
  ${EndIf}
FunctionEnd

Function ShowGuide
  Exec '"$WINDIR\notepad.exe" "$INSTDIR\开始使用.md"'
FunctionEnd

Function LaunchYuanshu
  Exec '"$INSTDIR\launcher\yuanshu.exe"'
FunctionEnd

Section "元枢" SecCore
  SectionIn RO
  SetOutPath "$INSTDIR"
  ${If} $NoTask != "1"
    !insertmacro StopService
  ${EndIf}

  DetailPrint "正在复制运行时（Node / Python / ffmpeg / Git），文件较多请稍候…"
  SetOutPath "$INSTDIR\runtime"
  File /r "${STAGE}\runtime\*"
  DetailPrint "正在复制元枢程序…"
  SetOutPath "$INSTDIR\app"
  File /r "${STAGE}\app\*"
  SetOutPath "$INSTDIR\launcher"
  File /r "${STAGE}\launcher\*"
  SetOutPath "$INSTDIR\template"
  File /r "${STAGE}\template\*"
  SetOutPath "$INSTDIR"
  File "${STAGE}\开始使用.md"

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\Yuanshu" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "元枢"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "元枢开源项目"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\launcher\yuanshu.ico"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  ; 体积由 build.mjs 在构建时算好传进来：${GetSize} 是脚本级循环，4 万多个文件实测 25 分钟还没跑完
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" ${ESTSIZE_KB}

  SetOutPath "$INSTDIR"
  CreateDirectory "$SMPROGRAMS\元枢"
  CreateShortcut "$SMPROGRAMS\元枢\元枢.lnk" "$INSTDIR\launcher\yuanshu.exe" "" "$INSTDIR\launcher\yuanshu.exe"
  CreateShortcut "$SMPROGRAMS\元枢\开始使用.lnk" "$WINDIR\notepad.exe" '"$INSTDIR\开始使用.md"'
  CreateShortcut "$SMPROGRAMS\元枢\打开工作区.lnk" "$PROFILE\pi-workspace"
  CreateShortcut "$SMPROGRAMS\元枢\卸载元枢.lnk" "$INSTDIR\uninstall.exe"
  CreateShortcut "$DESKTOP\元枢.lnk" "$INSTDIR\launcher\yuanshu.exe" "" "$INSTDIR\launcher\yuanshu.exe"

  ${If} $NoTask != "1"
    DetailPrint "正在注册开机自启并启动服务…"
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\launcher\register-task.ps1" -Root "$INSTDIR"'
    nsExec::Exec '"$INSTDIR\launcher\yuanshu.exe" --service-only'
    ; 2026-10-08 安装完成后展示访问令牌，新用户首次登录需要它
    ; 令牌在服务启动后写入 $INSTDIR\app\.token
    ; 稍待服务初始化
    Sleep 3000
    ClearErrors
    FileOpen $0 "$INSTDIR\app\.token" r
    ${IfNot} ${Errors}
      FileRead $0 $1
      FileClose $0
      StrCpy $1 $1 -1  ; 去掉末尾换行符
      MessageBox MB_OK|MB_ICONINFORMATION "元枢已安装完成！$\n$\n访问令牌（登录时需要）：$\n$1$\n$\n请复制以上令牌并妥善保存。"
    ${Else}
      MessageBox MB_OK|MB_ICONINFORMATION "元枢已安装完成！$\n$\n访问令牌在：$INSTDIR\app\.token$\n首次登录时请查看该文件。"
    ${EndIf}
  ${EndIf}
SectionEnd

Section "桌面客户端" SecDesktop
  ; 2026-10-08 可选组件：Tauri NSIS setup，静默调用安装（Tauri 固定装到 %LOCALAPPDATA%\元枢）
  ; 安装完成后桌面快捷方式指向实际位置，开机自启任务仍使用 Node 服务
  !ifdef HAVE_DESKTOP
    DetailPrint "正在安装桌面客户端（WebView 原生窗口）…"
    ; 先把 Tauri setup 复制到临时目录
    CreateDirectory "$TEMP\yuanshu-desktop-setup"
    SetOutPath "$TEMP\yuanshu-desktop-setup"
    File "${STAGE}\desktop\yuanshu-desktop.exe"
    ; 静默安装（Tauri NSIS 会装到 %LOCALAPPDATA%\元枢，/D 参数无效）
    ; /S 静默模式
    DetailPrint "正在运行 Tauri 安装器（静默模式）…"
    ExecWait '"$TEMP\yuanshu-desktop-setup\yuanshu-desktop.exe" /S' $0
    ; 清理临时 setup
    Delete "$TEMP\yuanshu-desktop-setup\yuanshu-desktop.exe"
    RMDir "$TEMP\yuanshu-desktop-setup"
    ; 检查安装结果
    ${If} $0 != 0
      DetailPrint "桌面客户端安装失败，错误码：$0"
      MessageBox MB_OK|MB_ICONEXCLAMATION "桌面客户端安装失败（错误码 $0）。$\n元枢主服务已安装完成，可通过浏览器访问。"
    ${Else}
      DetailPrint "桌面客户端安装成功"
      ; Tauri 实际装到 %LOCALAPPDATA%\元枢\yuanshu.exe，快捷方式指向实际位置
      CreateShortcut "$DESKTOP\元枢.lnk" "$LOCALAPPDATA\元枢\yuanshu.exe" "" "$INSTDIR\launcher\yuanshu.ico"
      CreateShortcut "$SMPROGRAMS\元枢\元枢（桌面端）.lnk" "$LOCALAPPDATA\元枢\yuanshu.exe" "" "$INSTDIR\launcher\yuanshu.ico"
      CreateShortcut "$SMPROGRAMS\元枢\元枢（浏览器）.lnk" "$INSTDIR\launcher\yuanshu.exe" "" "$INSTDIR\launcher\yuanshu.ico"
    ${EndIf}
  !endif
SectionEnd

Section "Uninstall"
  !insertmacro StopService
  nsExec::Exec `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${OWN_TASK}; if ($$own) { Unregister-ScheduledTask -TaskName yuanshu-watchdog -Confirm:$$false }"`
  Delete "$SMSTARTUP\元枢服务.lnk"
  Delete "$DESKTOP\元枢.lnk"
  RMDir /r "$SMPROGRAMS\元枢"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\launcher"
  RMDir /r "$INSTDIR\template"
  Delete "$INSTDIR\开始使用.md"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  ; 2026-10-08 Tauri 桌面端卸载（装在 %LOCALAPPDATA%\元枢）
  ExecWait '"$LOCALAPPDATA\元枢\uninstall.exe" /S'
  DeleteRegKey HKCU "${UNINSTKEY}"
  DeleteRegKey HKCU "Software\Yuanshu"
  IfSilent done
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时删除工作区（$PROFILE\pi-workspace）？$\r$\n$\r$\n里面是小语的记忆、人格与你的所有产出。选「否」则保留，重装后可以继续使用。" IDNO done
  RMDir /r "$PROFILE\pi-workspace"
  done:
SectionEnd
