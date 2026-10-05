; Pred inštaláciou/aktualizáciou natvrdo vypne bežiacu aplikáciu aj jej pomocné procesy
; (server stránky, go-ios tunel, cloudflared) – inak sa inštalátor môže zacykliť na „aplikácia beží“.
!macro customCheckAppRunning
  nsExec::Exec 'taskkill /F /T /IM "JD Phone Studio.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM "ios.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM "cloudflared.exe"'
  Pop $0
  Sleep 1500
!macroend
