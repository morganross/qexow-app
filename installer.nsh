!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\*\shell\Open in Qexow"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Open in Qexow"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Open in Qexow"
!macroend
