; Put `moka` on the user's PATH, and take it off again on uninstall.
;
; The CLI is bundled beside the app as moka.exe, so the install directory IS
; where the command lives. The previous PATH is remembered so an uninstall can
; restore it exactly — but only when the reader has not edited PATH since;
; an edited PATH is theirs and is left alone.

!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $0 HKCU "Environment" "Path"
  WriteRegStr HKCU "Software\MokaCanvas" "PathBeforeCli" "$0"
  StrCmp $0 "" 0 +3
    StrCpy $0 "$INSTDIR"
    Goto write
  StrCpy $0 "$0;$INSTDIR"
  write:
  WriteRegExpandStr HKCU "Environment" "Path" "$0"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ReadRegStr $0 HKCU "Environment" "Path"
  ReadRegStr $1 HKCU "Software\MokaCanvas" "PathBeforeCli"
  StrCmp $1 "" cleanup
  StrCpy $2 "$1;$INSTDIR"
  StrCmp $0 "$2" 0 +3
    WriteRegExpandStr HKCU "Environment" "Path" "$1"
    Goto cleanup
  StrCmp $0 "$INSTDIR" 0 cleanup
    WriteRegExpandStr HKCU "Environment" "Path" ""
  cleanup:
  DeleteRegKey HKCU "Software\MokaCanvas"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend
