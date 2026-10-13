; The stock NSIS directory page gets its path from BFFM_SELCHANGED.
; Windhawk's Modernize Folder Picker does not send that callback. nsDialogs
; reads the returned PIDL instead, so it works with either folder picker.
; Override only the directory page, keeping Tauri's installation/uninstall flow.
!include nsDialogs.nsh
!macroundef MUI_PAGE_DIRECTORY
!macro MUI_PAGE_DIRECTORY
  !insertmacro MUI_PAGE_INIT
  !insertmacro MUI_SET MUI_DIRECTORYPAGE ""
  !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  Var SuivelleDirectoryInput
  Var SuivelleDirectoryBrowse
  Page custom SuivelleDirectoryShow SuivelleDirectoryLeave

  Function SuivelleDirectoryShow
    Call SkipIfPassive
    !insertmacro MUI_HEADER_TEXT "$(MUI_TEXT_DIRECTORY_TITLE)" "$(MUI_TEXT_DIRECTORY_SUBTITLE)"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 30u "Choose the folder in which to install ${PRODUCTNAME}. Browse uses the selected folder exactly."
    Pop $0
    ${NSD_CreateLabel} 0 40u 100% 12u "Destination Folder"
    Pop $0
    ${NSD_CreateText} 0 55u -65u 14u "$INSTDIR"
    Pop $SuivelleDirectoryInput
    ${NSD_CreateBrowseButton} -60u 55u 60u 14u "Browse..."
    Pop $SuivelleDirectoryBrowse
    ${NSD_OnClick} $SuivelleDirectoryBrowse SuivelleDirectoryPick
    nsDialogs::Show
  FunctionEnd

  Function SuivelleDirectoryPick
    Pop $0 ; clicked button
    Push $0
    ${NSD_GetText} $SuivelleDirectoryInput $0
    nsDialogs::SelectFolderDialog "Select the folder to install ${PRODUCTNAME} in:" "$0"
    Pop $0
    ${If} $0 != error
    ${AndIf} $0 != ""
      ${NSD_SetText} $SuivelleDirectoryInput "$0"
    ${EndIf}
    Pop $0
  FunctionEnd

  Function SuivelleDirectoryLeave
    Push $0
    Push $1
    ${NSD_GetText} $SuivelleDirectoryInput $0
    System::Call 'shlwapi::PathIsRelativeW(w r0) i .r1'
    ${If} $0 == ""
    ${OrIf} $1 != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "Choose an absolute destination path, such as D:\${PRODUCTNAME}."
      Pop $1
      Pop $0
      Abort
    ${EndIf}
    StrCpy $INSTDIR "$0"
    Pop $1
    Pop $0
  FunctionEnd
!macroend
