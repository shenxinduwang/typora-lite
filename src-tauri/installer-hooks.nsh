; installer-hooks.nsh —— Tauri NSIS 安装/卸载钩子
; App 首启会自注册 HKCU\Software\Classes 下的关联键（ProgId Typora-Lite.md、
; .md/.markdown 的 ShellNew 与 OpenWithProgids 登记项）。安装器只回收它自己
; 建的那部分，这些"运行时自注册"的键卸载后不会被清；在这里补齐，做到装/卸都干净。
; 注意：OpenWithProgids 下可能登记着其他编辑器的 ProgId，只删自己的值、
; 键留 /ifempty；.md 的默认值若已被用户改走，绝不回写。

!macro NSIS_HOOK_POSTUNINSTALL
  ; 自建 ProgId 整棵删（含 shell\open\command、DefaultIcon、ShellNew）
  DeleteRegKey HKCU "Software\Classes\Typora-Lite.md"

  ; .md / .markdown 下只清自己写的 ShellNew 值与键
  DeleteRegValue HKCU "Software\Classes\.md\ShellNew" "NullFile"
  DeleteRegValue HKCU "Software\Classes\.md\ShellNew" "IconPath"
  DeleteRegKey /ifempty HKCU "Software\Classes\.md\ShellNew"
  DeleteRegValue HKCU "Software\Classes\.markdown\ShellNew" "NullFile"
  DeleteRegValue HKCU "Software\Classes\.markdown\ShellNew" "IconPath"
  DeleteRegKey /ifempty HKCU "Software\Classes\.markdown\ShellNew"

  ; OpenWithProgids 里只删自己的登记值，其他应用的保留
  DeleteRegValue HKCU "Software\Classes\.md\OpenWithProgids" "Typora-Lite.md"
  DeleteRegKey /ifempty HKCU "Software\Classes\.md\OpenWithProgids"
  DeleteRegValue HKCU "Software\Classes\.markdown\OpenWithProgids" "Typora-Lite.md"
  DeleteRegKey /ifempty HKCU "Software\Classes\.markdown\OpenWithProgids"

  ; Tauri 卸载器删 ProgId 但不删扩展名默认值，会留悬挂指向；仅当默认值仍
  ; 指向自家 ProgId 时才清，已被用户/其他软件改走的一律不碰
  ReadRegStr $0 HKCU "Software\Classes\.md" ""
  StrCmp $0 "md" 0 +2
    DeleteRegValue HKCU "Software\Classes\.md" ""
  ReadRegStr $0 HKCU "Software\Classes\.markdown" ""
  StrCmp $0 "markdown" 0 +2
    DeleteRegValue HKCU "Software\Classes\.markdown" ""
!macroend
