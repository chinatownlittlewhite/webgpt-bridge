!define WEBGPT_BRIDGE_HOST_PREP_TASK "WebGPT Bridge Host Preparation"
!define WEBGPT_BRIDGE_HOST_PREP_RELATIVE "resources\app.asar.unpacked\agent-runtime\native\windows-host-prep\bin\release\lpc-windows-host-prep.exe"

!macro customInstall
  DetailPrint "Preparing Windows AppContainer host access..."
  ExecWait '"$INSTDIR\${WEBGPT_BRIDGE_HOST_PREP_RELATIVE}" --apply' $0
  ${If} $0 != 0
    Abort "WebGPT Bridge host preparation failed (exit $0). Repair or reinstall as administrator."
  ${EndIf}

  DetailPrint "Registering ${WEBGPT_BRIDGE_HOST_PREP_TASK}..."
  ExecWait '"$SYSDIR\schtasks.exe" /Create /TN "${WEBGPT_BRIDGE_HOST_PREP_TASK}" /TR "$\"$INSTDIR\${WEBGPT_BRIDGE_HOST_PREP_RELATIVE}$\" --apply" /SC ONSTART /RU SYSTEM /RL HIGHEST /F' $1
  ${If} $1 != 0
    DetailPrint "Scheduled-task registration failed (exit $1); removing the product-owned null-device ACE."
    ExecWait '"$INSTDIR\${WEBGPT_BRIDGE_HOST_PREP_RELATIVE}" --remove' $2
    Abort "Unable to register WebGPT Bridge Windows host preparation task (exit $1)."
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
