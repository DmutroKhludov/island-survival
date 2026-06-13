@echo off
title Ostrovok online
echo.
echo [1/2] Starting island server on port 3001 ...
start "Ostrovok server" cmd /k node server.js
timeout /t 2 >nul
echo.
echo [2/2] Opening internet tunnel ...
echo.
echo Wait a few seconds. A line will appear like:
echo     https://XXXXXXXX.lhr.life
echo Copy that https link and send it to your friend.
echo Keep this window open while you play.
echo.
ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -R 80:localhost:3001 nokey@localhost.run
echo.
echo Tunnel closed. Press any key to exit.
pause >nul
