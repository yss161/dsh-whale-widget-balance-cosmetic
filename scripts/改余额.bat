@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo ============================================
echo  小鲸鱼挂件 - 余额显示美化
echo ============================================
echo.
echo  1. 设置起始余额（会随消耗递减）
echo  2. 固定显示某个数字（永不变化）
echo  3. 还原成真实余额
echo  4. 退出
echo.
set /p CH=请选择 [1-4]: 
if "%CH%"=="1" goto spend
if "%CH%"=="2" goto fixed
if "%CH%"=="3" goto restore
goto end

:spend
set /p AMT=输入起始余额（例如 2000）: 
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0改余额B.ps1" %AMT%
goto done

:fixed
set /p AMT=输入要固定显示的数字（例如 2000）: 
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0改余额B.ps1" %AMT% -Fixed
goto done

:restore
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0改余额B.ps1" -Restore
goto done

:done
echo.
echo 完成！请回到 DSH 页面按 Ctrl+F5 硬刷新。
pause

:end
endlocal