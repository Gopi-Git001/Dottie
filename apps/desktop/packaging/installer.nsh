; Dottie NSIS hooks (included by electron-builder; per-user install, no elevation).
; Clean uninstall: electron-builder removes binaries, shortcuts and the HKCU uninstall entry.
; This macro additionally:
;   1. removes the per-user start-at-sign-in entry (written by app.setLoginItemSettings), and
;   2. on an interactive uninstall, ASKS whether to delete user data (%APPDATA%\Dottie: settings,
;      logs). Default button = No (keep). User documents are never touched.
; Never runs its prompt during auto-updates (isUpdated) so upgrades don't prompt or wipe data.
; Silent uninstall (/S) keeps user data unless electron-builder's built-in --delete-app-data
; flag is passed (handled by the stock uninstaller after this macro).

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Dottie"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Dottie"

    ClearErrors
    ${GetParameters} $R0
    ${GetOptions} $R0 "--delete-app-data" $R1
    ${if} ${Errors}
      IfSilent dottie_keep_data
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
        "Also delete your Dottie settings and logs?$\r$\n$\r$\n$APPDATA\${PRODUCT_NAME}$\r$\n$\r$\nYour own documents are never touched. Choose No to keep settings for a later reinstall." \
        /SD IDNO IDNO dottie_keep_data
      RMDir /r "$APPDATA\${PRODUCT_NAME}"
      RMDir /r "$LOCALAPPDATA\${PRODUCT_NAME}"
      dottie_keep_data:
    ${endIf}
  ${endIf}
!macroend
