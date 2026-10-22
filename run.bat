@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ==========================================
echo   Yuketang video autoplay
echo ==========================================

set "NODE_EXE="
set "NPM_CMD="

where node >nul 2>nul && set "NODE_EXE=node" && set "NPM_CMD=npm"
if not defined NODE_EXE if exist "%~dp0.runtime\node\node.exe" (
    set "NODE_EXE=%~dp0.runtime\node\node.exe"
    set "NPM_CMD=%~dp0.runtime\node\npm.cmd"
)
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
    set "NPM_CMD=%ProgramFiles%\nodejs\npm.cmd"
)
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
    set "NPM_CMD=%LOCALAPPDATA%\Programs\nodejs\npm.cmd"
)

if not defined NODE_EXE (
    echo [*] Node not found. Downloading portable Node 20 ^(about 30MB, first run only^) ...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $v='v20.18.1'; $f='node-v20.18.1-win-x64.zip'; $urls=@('https://nodejs.org/dist/'+$v+'/'+$f,'https://cdn.npmmirror.com/binaries/node/'+$v+'/'+$f,'https://npmmirror.com/mirrors/node/'+$v+'/'+$f); $z=Join-Path $env:TEMP 'node-portable.zip'; foreach($u in $urls){ try { Write-Host ('    downloading from '+$u); Invoke-WebRequest $u -OutFile $z -UseBasicParsing -TimeoutSec 120; break } catch { Write-Host '    failed, trying next mirror...' } }; if (-not (Test-Path $z)) { throw 'all mirrors failed' }; $d='%~dp0.runtime'; New-Item -ItemType Directory -Force -Path $d > $null; Write-Host '    extracting...'; Expand-Archive $z -DestinationPath $d -Force; $src=@(Get-ChildItem -Path $d -Directory -Filter 'node-v*-win-x64'); if ($src.Count -gt 0) { Move-Item $src[0].FullName (Join-Path $d 'node') -Force }; Remove-Item $z -Force -ErrorAction SilentlyContinue"
    if exist "%~dp0.runtime\node\node.exe" (
        set "NODE_EXE=%~dp0.runtime\node\node.exe"
        set "NPM_CMD=%~dp0.runtime\node\npm.cmd"
    )
)

if not defined NODE_EXE (
    echo [x] Failed to get Node. Please install Node 20+ from https://nodejs.org and re-run.
    pause
    exit /b 1
)
echo [*] Node: !NODE_EXE!

if not exist "node_modules\playwright-core\package.json" (
    echo [*] First run: installing playwright-core ...
    call "!NPM_CMD!" install playwright-core --no-audit --no-fund --loglevel=error
    if errorlevel 1 (
        echo [x] Dependency install failed. Check your network and re-run.
        pause
        exit /b 1
    )
)

echo.
"!NODE_EXE!" autoplay.mjs %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
    echo [x] Exit code %RC%
    pause
) else (
    echo [ok] Done. Log file: .watch-log.txt
    timeout /t 3 >nul
)
exit /b %RC%