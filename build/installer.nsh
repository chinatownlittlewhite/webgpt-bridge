!define WEBGPT_BRIDGE_HOST_PREP_TASK "WebGPT Bridge Host Preparation"
!define WEBGPT_BRIDGE_HOST_RELATIVE "resources\app.asar.unpacked\agent-runtime\native\windows-host\bin\release\lpc-windows-host.exe"
!define WEBGPT_BRIDGE_PROTECTED_HOST_ROOT "WebGPT Bridge Host"

!macro customInstall
  ; The application directory is user-selectable. Never let the SYSTEM startup task execute from it.
  StrCpy $9 "$PROGRAMFILES\${WEBGPT_BRIDGE_PROTECTED_HOST_ROOT}"
  !ifdef APP_64
    ${If} ${RunningX64}
      StrCpy $9 "$PROGRAMFILES64\${WEBGPT_BRIDGE_PROTECTED_HOST_ROOT}"
    ${EndIf}
  !endif
  CreateDirectory "$9"
  ClearErrors
  CopyFiles /SILENT "$INSTDIR\${WEBGPT_BRIDGE_HOST_RELATIVE}" "$9\lpc-windows-host.exe"
  ${If} ${Errors}
    Abort "Unable to install the protected WebGPT Bridge Windows host helper."
  ${EndIf}
  ClearErrors
  CopyFiles /SILENT "$INSTDIR\resources\windows-host-prep-task.xml" "$9\windows-host-prep-task.xml"
  ${If} ${Errors}
    Delete "$9\lpc-windows-host.exe"
    Abort "Unable to install the protected WebGPT Bridge host-preparation task definition."
  ${EndIf}

  DetailPrint "Registering ${WEBGPT_BRIDGE_HOST_PREP_TASK}..."
  ; The fixed XML preserves the security intent of the legacy flags: /RU SYSTEM /SC ONSTART /RL HIGHEST.
  nsExec::ExecToStack /OEM '"$SYSDIR\schtasks.exe" /Create /TN "${WEBGPT_BRIDGE_HOST_PREP_TASK}" /XML "$9\windows-host-prep-task.xml" /F'
  Pop $1
  Pop $2
  ${If} $1 != 0
    Delete "$9\windows-host-prep-task.xml"
    Delete "$9\lpc-windows-host.exe"
    RMDir "$9"
    Abort "Unable to register WebGPT Bridge Windows host preparation task (exit $1): $2"
  ${EndIf}

  DetailPrint "Preparing Windows AppContainer host access..."
  ExecWait '"$9\lpc-windows-host.exe" host-prep --apply' $0
  ${If} $0 != 0
    DetailPrint "Host preparation failed (exit $0); deleting the newly registered SYSTEM task before aborting."
    ExecWait '"$SYSDIR\schtasks.exe" /Delete /TN "${WEBGPT_BRIDGE_HOST_PREP_TASK}" /F' $2
    Delete "$9\windows-host-prep-task.xml"
    Delete "$9\lpc-windows-host.exe"
    RMDir "$9"
    Abort "WebGPT Bridge host preparation failed (exit $0). Repair or reinstall as administrator."
  ${EndIf}
!macroend

!macro customUnInstall
  StrCpy $9 "$PROGRAMFILES\${WEBGPT_BRIDGE_PROTECTED_HOST_ROOT}"
  !ifdef APP_64
    ${If} ${RunningX64}
      StrCpy $9 "$PROGRAMFILES64\${WEBGPT_BRIDGE_PROTECTED_HOST_ROOT}"
    ${EndIf}
  !endif
  DetailPrint "Removing WebGPT Bridge Windows host preparation..."
  ExecWait '"$9\lpc-windows-host.exe" host-prep --remove' $0
  ${If} $0 != 0
    DetailPrint "WARNING: host-preparation ACE removal failed with exit $0; no broad DACL reset will be attempted."
  ${EndIf}

  ExecWait '"$SYSDIR\schtasks.exe" /Delete /TN "${WEBGPT_BRIDGE_HOST_PREP_TASK}" /F' $1
  ${If} $1 != 0
    DetailPrint "WARNING: scheduled-task removal returned exit $1."
  ${EndIf}
  Delete "$9\windows-host-prep-task.xml"
  Delete "$9\lpc-windows-host.exe"
  RMDir "$9"
!macroend
