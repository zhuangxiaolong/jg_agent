@echo off
setlocal
set "APP_EXE=%~dp0..\..\精工智能开发平台.exe"
if not exist "%APP_EXE%" (
  echo 未找到精工智能开发平台主程序，请先完成安装。
  exit /b 1
)
"%APP_EXE%" --cli %*
exit /b %ERRORLEVEL%
