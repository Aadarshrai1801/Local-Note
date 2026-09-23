; Extra NSIS steps for the Local Note installer.

; Default the installation directory to D: when that drive exists, so a user who
; keeps large files off their system drive does not have to change the path by
; hand. The directory picker is still shown (allowToChangeInstallationDirectory
; is enabled), so this is only a default.
;
; IfFileExists with a single jump target branches when the file is NOT found:
; on a machine without a D: drive the next line is skipped and the standard
; %LOCALAPPDATA%\Programs location is used instead.
!macro preInit
  IfFileExists "D:\*.*" 0 +2
  StrCpy $INSTDIR "D:\Local Note"
!macroend

!macro customUnInstall
  ; Meeting data lives in the app's data directory (D:\Local Note\.localnote-data
  ; on this machine) and is deliberately left in place, so an uninstall never
  ; destroys recordings or transcripts. Remove that folder by hand to delete
  ; everything.
!macroend
