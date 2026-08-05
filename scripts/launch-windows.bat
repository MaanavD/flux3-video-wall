@echo off
cd /d "%~dp0app"

if not exist .env.local (
  echo ======================================
  echo  FLUX 3 Video Wall - first-time setup
  echo ======================================
  set /p BFL_KEY="Paste your BFL API key (or press Enter to skip for now): "
  (
    echo BFL_API_KEY=%BFL_KEY%
    echo BFL_MODEL_ENDPOINT=https://api.bfl.ai/v1/flux-3-video
    echo BFL_RESOLUTION=hd
    echo BFL_CONCURRENCY=8
    echo LOCAL_API_PORT=8788
  ) > .env.local
  echo Saved to app\.env.local - edit this file any time to change your key.
)

start "FLUX 3 API" /min node.exe --env-file-if-exists=.env.local local\server.mjs
start "FLUX 3 Wall" /min node.exe node_modules\vinext\dist\cli.js start

timeout /t 4 /nobreak >nul
start http://localhost:3000

echo FLUX 3 Video Wall is running.
echo Close the "FLUX 3 API" and "FLUX 3 Wall" windows to stop it.
pause
