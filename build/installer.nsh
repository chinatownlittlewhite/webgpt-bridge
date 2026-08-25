!define WEBGPT_BRIDGE_HOST_PREP_TASK "WebGPT Bridge Host Preparation"
!define WEBGPT_BRIDGE_HOST_PREP_RELATIVE "resources\app.asar.unpacked\agent-runtime\native\windows-host-prep\bin\release\lpc-windows-host-prep.exe"
!define WEBGPT_BRIDGE_HOST_PREP_TASK_XML "resources\windows-host-prep-task.xml"

; electron-builder's per-machine init accepts /D= before customInit runs.
; Re-pin the installation root so the SYSTEM task can never target a user-writable override.
!macro customInit
  StrCpy $0 "$PROGRAMFILES"
  !ifdef APP_64
    ${If} ${RunningX64}
      StrCpy $0 "$PROGRAMFILES64"
    ${EndIf}
  !endif
  !ifdef MENU_FILENAME
    StrCpy $0 "$0\${MENU_FILENAME}"
  !endif
  StrCpy $INSTDIR "$0\${APP_FILENAME}"
!macroend

!macro customInstall
  DetailPrint "Registering ${WEBGPT_BRIDGE_HOST_PREP_TASK}..."
  nsExec::ExecToStack /OEM '"$SYSDIR\schtasks.exe" /Create /TN "${WEBGPT_BRIDGE_HOST_PREP_TASK}" /XML "$INSTDIR\${WEBGPT_BRIDGE_HOST_PREP_TASK_XML}" /F'
  Pop $1
  Pop $2
  ${If} $1 != 0
    Abort "Unable to register WebGPT Bridge Windows host preparation task (exit $1): $2"
  ${EndIf}

  DetailPrint "Preparing Windows AppContainer host access..."
  ExecWait '"$INSTDIR\${WEBGPT_BRIDGE_HOST_PREP_RELATIVE}" --apply' $0
  ${If} $0 != 0
    DetailPrint "Host preparation failed (exit $0); deleting the newly registered SYSTEM task before aborting."
    ExecWait '"$SYSDIR\schtasks.exe" /Delete /TN "${WEBGPT_BRIDGE_HOST_PREP_TASK}" /F' $2
    Abort "WebGPT Bridge host preparation failed (exit $0). Repair or reinstall as administrator."
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Removing WebGPT Bridge Windows host preparation..."
  ExecWait '"$INSTDIR\${WEBGPT_BRIDGE_HOST_PREP_RELATIVE}" --remove' $0
  ${If} $0 != 0
    DetailPrint "WARNING: host-preparation ACE removal failed with exit $0; no broad DACL reset will be attempted."
  ${EndIf}

  ExecWait '"$SYSDIR\schtasks.exe" /Delete /TN "${WEBGPT_BRIDGE_HOST_PREP_TASK}" /F' $1
  ${If} $1 != 0
    DetailPrint "WARNING: scheduled-task removal returned exit $1."
  ${EndIf}
!macroend
