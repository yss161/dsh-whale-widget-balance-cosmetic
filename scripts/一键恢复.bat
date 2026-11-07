@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================================
echo   小鲸鱼挂件 - 余额补丁 一键恢复
echo ============================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [X] 没有找到 Node.js
  echo     请先安装 Node.js: https://nodejs.org/
  echo     或者改用 改余额.bat（它调用 PowerShell，不需要 Node）
  echo.
  pause
  exit /b 1
)

node restore-patch.mjs
set RC=!errorlevel!

echo.
if !RC!==0 (
  echo ------------------------------------------------------------
  echo  完成。请回到 DSH 页面按 Ctrl+F5 硬刷新。
  echo ------------------------------------------------------------
) else (
  echo ------------------------------------------------------------
  echo  出错了（代码 !RC!），请看上面的提示。
  echo ------------------------------------------------------------
)
echo.
pause
endlocal