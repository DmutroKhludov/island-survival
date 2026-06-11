@echo off
chcp 65001 >nul
title Островок — онлайн
echo.
echo   [1/2] Запускаю сервер острова (порт 3001)...
start "Островок — сервер" cmd /k node server.js
timeout /t 2 >nul
echo.
echo   [2/2] Открываю туннель в интернет (localhost.run)...
echo.
echo   Через пару секунд ниже появится строка вида:
echo        XXXX–XXXX.lhr.life tunneled ... https://XXXXXXXX.lhr.life
echo   ^>^>^>  Скопируй ссылку https://....lhr.life и отправь другу.  ^<^<^<
echo.
echo   (Не закрывай это окно, пока играете. Свой ПК держи включённым.)
echo.
ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -R 80:localhost:3001 nokey@localhost.run
echo.
echo   Туннель закрылся. Нажми любую клавишу для выхода.
pause >nul
