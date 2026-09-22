; Extra NSIS steps for the Local Note installer.
;
; Kept intentionally minimal: Local Note writes nothing outside its own app-data
; folder, and the uninstaller is told not to delete the user's meeting data.

!macro customUnInstall
  ; Meeting data lives in %APPDATA%\Local Note and is deliberately left in
  ; place so an uninstall never destroys recordings or transcripts.
!macroend
