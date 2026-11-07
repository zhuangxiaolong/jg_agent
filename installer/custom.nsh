!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${ifNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 "是否保留精工智能开发平台本地会话、项目工作区和设置？选择‘否’将删除当前用户的应用数据。" IDYES keepUserData
      RMDir /r "$LOCALAPPDATA\JinggongAgent"
      keepUserData:
    ${endIf}
  ${endIf}
!macroend
