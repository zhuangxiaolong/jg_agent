@echo off
setlocal
set "APP_EXE=%~dp0..\..\精工 Agent.exe"
if not exist "%APP_EXE%" (
  echo 未找到精工 Agent 主程序，请先完成安装。
  exit /b 1
)
"%APP_EXE%" --cli %*
exit /b %ERRORLEVEL%
