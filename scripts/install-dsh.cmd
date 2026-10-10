@echo off
rem ===========================================================================
rem  dsh-gitee-chat - installer for Windows (cmd.exe)
rem
rem  Why a .cmd and not a .ps1: managed machines often run PowerShell with
rem  ExecutionPolicy=Restricted, which blocks a .ps1 before it starts. This file
rem  is deliberately ASCII-only: on a console with codepage 936 (GBK) non-ASCII
rem  text is mangled, and mangled bytes can break the parser.
rem
rem  Usage:  scripts\install-dsh.cmd [registry]
rem          registry - optional npm registry (e.g. https://registry.npmmirror.com)
rem
rem  The single supported install method:
rem
rem      dsh plugin --profile [profile] add "file:[this repo]"
rem
rem  - "file:" (not a bare path, not "link:"): a bare path becomes a symlink and
rem    the agent half then cannot resolve @deepseek-ai/*; "file:" installs a copy.
rem  - a copy means upgrading is remove + add, which is what this script does.
rem  - on the desktop profile only the CLI bundled with the app can do this:
rem    an npm -g installed dsh refuses --profile desktop. The same operation is
rem    also available in the app: Settings - Plugins - Add plugin.
rem
rem  Steps
rem    1. make sure Node.js 22.19 or newer (or 24+) is available - needed to build
rem    2. pick the profile and locate a dsh CLI that may manage it
rem    3. make "dsh" usable from PowerShell too (npm ships a .ps1 shim there)
rem    4. build this repo (lib/ is not tracked, so the consumer always builds)
rem    5. remove + add the package as a local "file:" dependency
rem    6. write the profile configuration - scripts\setup.mjs apply - and verify
rem ===========================================================================
setlocal EnableExtensions EnableDelayedExpansion

set "REGISTRY=%~1"
if defined REGISTRY set "NPM_CONFIG_REGISTRY=%REGISTRY%"

set "NODE_MIN_MAJOR=22"
set "NODE_MIN_MINOR=19"
set "PACKAGE_NAME=dsh-gitee-chat"

rem  the repo root = the parent of this scripts\ folder  (absolute, no trailing ..)
for %%I in ("%~dp0..") do set "REPO_DIR=%%~fI"

if not defined DSH_HOME set "DSH_HOME=%USERPROFILE%\.dsh"

set "NODE_EXE="
set "NODE_FOR="
set "NODE_SOURCE="
set "NPM_CMD="
set "PNPM_MJS="
set "DSH_EXE="
set "DSH_VERSION="
set "PROFILE="
set "PROFILE_REASON="
set "BUILD_OK=0"
set "POLICY_NOTE="

echo.
echo === dsh-gitee-chat installer ===
echo   repo    : !REPO_DIR!
echo   dsh home: %DSH_HOME%
echo.

call :RefreshPath

rem ---------------------------------------------------------------------------
rem  1. Node.js
rem ---------------------------------------------------------------------------
where node >nul 2>nul
if not errorlevel 1 (
  set "NODE_EXE=node"
  set "NODE_FOR=node"
  set "NODE_SOURCE=path"
)

rem  Prefer the Node.js bundled with the desktop app over installing one: it is
rem  the runtime the app itself uses, and it needs no elevation.
if not defined NODE_EXE (
  set "BUNDLED_NODE=%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  if exist "!BUNDLED_NODE!" (
    set "NODE_EXE=!BUNDLED_NODE!"
    set "NODE_FOR="!NODE_EXE!""
    set "NODE_SOURCE=bundled"
    rem  the package's prepare script runs "node build.mjs", so node must be on PATH
    set "NODE_BIN=%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin"
    set "PATH=!NODE_BIN!;!PATH!"
    set "PNPM_MJS=%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
    if not exist "!PNPM_MJS!" set "PNPM_MJS="
    echo [i] using the Node.js bundled with the desktop app
  )
)

if not defined NODE_EXE (
  echo [..] Node.js not found - trying winget ^(OpenJS.NodeJS.LTS^) ...
  winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
  call :RefreshPath
  where node >nul 2>nul
  if not errorlevel 1 (
    set "NODE_EXE=node"
    set "NODE_FOR=node"
    set "NODE_SOURCE=path"
  )
)
if not defined NODE_EXE (
  echo [FAIL] Node.js is required to build this package.
  echo        Install it ^(winget install OpenJS.NodeJS.LTS^), or open a new
  echo        terminal if you just installed it, then run this script again.
  goto :Fail
)
set "NODE_VERSION="
for /f "usebackq delims=" %%V in (`!NODE_FOR! -v`) do set "NODE_VERSION=%%V"
call :CheckNode "!NODE_VERSION!"
if not "!NODE_OK!"=="1" (
  echo [FAIL] Node.js !NODE_VERSION! is too old - need 22.19 or newer ^(or 24+^).
  goto :Fail
)
echo [ok] Node.js !NODE_VERSION!  ^(source: !NODE_SOURCE!^)

if "!NODE_SOURCE!"=="path" (
  where npm >nul 2>nul
  if errorlevel 1 (
    echo [FAIL] npm not found next to Node.js - reinstall Node.js with npm included.
    goto :Fail
  )
  set "NPM_CMD=npm"
  set "NPM_PREFIX="
  for /f "usebackq delims=" %%P in (`npm prefix -g`) do set "NPM_PREFIX=%%P"
  if defined NPM_PREFIX set "PATH=!NPM_PREFIX!;!PATH!"
)

rem ---------------------------------------------------------------------------
rem  2. profile + dsh CLI
rem ---------------------------------------------------------------------------
call :FindDesktopCli

set "PROFILE=web"
set "PROFILE_REASON=default for a non-desktop install"
if defined GITEE_CHAT_DSH_PROFILE (
  set "PROFILE=%GITEE_CHAT_DSH_PROFILE%"
  set "PROFILE_REASON=GITEE_CHAT_DSH_PROFILE"
) else (
  if defined DSH_EXE (
    set "PROFILE=desktop"
    set "PROFILE_REASON=the desktop app is installed"
  )
)
echo [..] profile: !PROFILE!  ^(!PROFILE_REASON!^)

if /i "!PROFILE!"=="desktop" (
  if not defined DSH_EXE (
    echo [FAIL] the "desktop" profile is managed exclusively by the DeepSeek
    echo        Harness app, and its bundled CLI was not found.
    echo        Do one of these:
    echo          a^) open the app once, then use Settings - Plugins - Add plugin:
    echo               file:!REPO_DIR!
    echo          b^) in the app use "Manage dsh Command..." and then run:
    echo               dsh plugin --profile desktop add "file:!REPO_DIR!"
    goto :Fail
  )
  if not exist "%DSH_HOME%\profiles\desktop\package.json" (
    echo [i] the desktop profile has not been initialized yet - open the
    echo     DeepSeek Harness app once, then run this script again.
    echo     ^(continuing - the plugin command reports the same thing^)
  )
  set "DSH_VERSION="
  for /f "usebackq delims=" %%V in (`"!DSH_EXE!" --version`) do set "DSH_VERSION=%%V"
  echo [ok] desktop dsh CLI: !DSH_EXE!  !DSH_VERSION!
) else (
  for /f "usebackq delims=" %%P in (`where dsh 2^>nul`) do if not defined DSH_EXE set "DSH_EXE=%%P"
  if not defined DSH_EXE (
    echo [..] dsh CLI not found - installing @deepseek-ai/dsh globally ...
    call npm install -g @deepseek-ai/dsh@latest
    if errorlevel 1 (
      echo [FAIL] could not install the dsh CLI - check the network or the registry.
      goto :Fail
    )
    for /f "usebackq delims=" %%P in (`where dsh 2^>nul`) do if not defined DSH_EXE set "DSH_EXE=%%P"
  )
  if not defined DSH_EXE (
    echo [FAIL] the dsh CLI is still not on PATH - open a new terminal and run this again.
    goto :Fail
  )
  echo [ok] dsh CLI: !DSH_EXE!
  rem the CLI shells out to pnpm for "plugin" commands
  where pnpm >nul 2>nul
  if errorlevel 1 (
    echo [..] pnpm not found - installing it globally ^(the dsh CLI uses it^) ...
    call npm install -g pnpm
  )
)

rem ---------------------------------------------------------------------------
rem  3. PowerShell shims   (npm's global "dsh" is a .ps1 there)
rem ---------------------------------------------------------------------------
rem  npm writes THREE shims (dsh / dsh.cmd / dsh.ps1). PowerShell prefers .ps1,
rem  and the stock Windows client policy (Restricted) refuses any script file -
rem  so "dsh -V" dies in PowerShell even though dsh.cmd runs fine in cmd.
rem
rem  Deliberately narrow:
rem    - only lift the STOCK default (Restricted -> RemoteSigned, CurrentUser only)
rem    - never loosen a deliberate stricter setting (AllSigned) - only advise
rem    - never touch a machine that can already run scripts
rem  Windows PowerShell 5.1 (powershell.exe) and PowerShell 7 (pwsh.exe) keep
rem  SEPARATE policy stores, so both are probed when present.
if not "!PROFILE!"=="desktop" (
  call :PolicyCheck powershell
  call :PolicyCheck pwsh
)

rem ---------------------------------------------------------------------------
rem  4. build
rem ---------------------------------------------------------------------------
pushd "!REPO_DIR!"
if defined NPM_CMD (
  echo [..] npm install --legacy-peer-deps
  call npm install --legacy-peer-deps
  if not errorlevel 1 (
    echo [..] npm run build
    call npm run build
    if not errorlevel 1 set "BUILD_OK=1"
  )
) else (
  if defined PNPM_MJS (
    rem  confirmModulesPurge: a stale node_modules would otherwise block a
    rem  scripted install with "Aborted removal of modules directory due to no TTY".
    echo [..] pnpm install  ^(bundled pnpm^)
    call "!NODE_EXE!" "!PNPM_MJS!" install --config.confirmModulesPurge=false --config.minimumReleaseAge=0
    if not errorlevel 1 (
      echo [..] pnpm run build  ^(bundled pnpm^)
      call "!NODE_EXE!" "!PNPM_MJS!" run build
      if not errorlevel 1 set "BUILD_OK=1"
    )
  ) else (
    echo [FAIL] neither npm nor a bundled pnpm is available - cannot build.
  )
)
popd
if not "!BUILD_OK!"=="1" goto :BuildFail
echo [ok] build

rem ---------------------------------------------------------------------------
rem  5. install into the profile  (remove first: "file:" is a copy)
rem ---------------------------------------------------------------------------
call "!DSH_EXE!" plugin --profile "%PROFILE%" remove "%PACKAGE_NAME%"
if errorlevel 1 echo [i] %PACKAGE_NAME% was not installed in profile "!PROFILE!" yet
echo [..] dsh plugin --profile !PROFILE! add "file:!REPO_DIR!"
call "!DSH_EXE!" plugin --profile "%PROFILE%" add "file:!REPO_DIR!"
if errorlevel 1 goto :PluginFail
echo [ok] installed into profile "!PROFILE!"

rem ---------------------------------------------------------------------------
rem  6. profile configuration + verification
rem ---------------------------------------------------------------------------
pushd "!REPO_DIR!"
echo [..] setup.mjs apply
call "!NODE_EXE!" scripts\setup.mjs apply
if errorlevel 1 (
  popd
  goto :ApplyFail
)
echo [..] setup.mjs repair  ^(clears leftover half state from the plugin market^)
call "!NODE_EXE!" scripts\setup.mjs repair
echo [..] setup.mjs verify
call "!NODE_EXE!" scripts\setup.mjs verify
if errorlevel 1 echo [warn] setup.mjs verify reported issues - read the list above
popd

echo.
echo ===========================================================================
echo  Done.
if defined POLICY_NOTE (
  echo  PowerShell still blocks script files here, and npm's "dsh" there is a
  echo  .ps1 - so call the batch shim instead:
  echo    dsh.cmd --version
  echo.
)
echo    1. Restart the DeepSeek Harness desktop app ^(or reload the web page^).
echo       The profile patch is composed at startup, so new code only takes
echo       effect after a restart.
echo    2. Settings - Plugins shows the plugin state. Use a Gitee preset in a
echo       NEW session.
echo    3. Token / enterprise id:  "!NODE_EXE!" scripts\setup.mjs verify
echo ===========================================================================
endlocal
exit /b 0

:Fail
echo.
echo [FAIL] see the messages above.
endlocal
exit /b 1

:BuildFail
echo.
echo [FAIL] build failed.
echo        Common causes: no network, or pnpm/esbuild blocked a build script.
endlocal
exit /b 2

:PluginFail
echo.
echo [FAIL] "dsh plugin ... add" failed.
echo        - If it mentions ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION, retry with
echo          a fresh install or a mirror registry.
echo        - For the "desktop" profile the app can do the same from
echo          Settings - Plugins - Add plugin ^(paste file:!REPO_DIR!^).
endlocal
exit /b 3

:ApplyFail
echo.
echo [FAIL] scripts\setup.mjs apply failed.
endlocal
exit /b 4

rem ---------------------------------------------------------------------------
rem  :FindDesktopCli - locate the app's resources\runtime\cli\bin\dsh.cmd
rem  Well known folders first, then the Uninstall registry entries (a per-user
rem  install has no App Paths entry).
rem ---------------------------------------------------------------------------
:FindDesktopCli
if defined DSH_EXE goto :eof
call :TryDesktopDir "%LOCALAPPDATA%\Programs\DeepSeek Harness"
call :TryDesktopDir "%ProgramFiles%\DeepSeek Harness"
call :TryDesktopDir "C:\Programs\DeepSeek Harness"
if defined DSH_EXE goto :eof
call :ScanInstallLocation "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall"
call :ScanInstallLocation "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
call :ScanInstallLocation "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
goto :eof

:TryDesktopDir
if defined DSH_EXE goto :eof
if "%~1"=="" goto :eof
if not exist "%~1\resources\runtime\cli\bin\dsh.cmd" goto :eof
set "DSH_EXE=%~1\resources\runtime\cli\bin\dsh.cmd"
goto :eof

:ScanInstallLocation
if defined DSH_EXE goto :eof
if "%~1"=="" goto :eof
for /f "tokens=2,*" %%A in ('reg query "%~1" /s /v InstallLocation 2^>nul ^| findstr /i "REG_SZ"') do call :TryDesktopDir "%%~B"
goto :eof

rem ---------------------------------------------------------------------------
rem  :CheckNode - set NODE_OK=1 when "vX.Y.Z" satisfies the minimum
rem ---------------------------------------------------------------------------
:CheckNode
set "NODE_OK=0"
set "V=%~1"
if not defined V goto :eof
set "V=%V:v=%"
set "MAJ="
set "MIN="
for /f "tokens=1,2 delims=." %%A in ("%V%") do (
  set "MAJ=%%A"
  set "MIN=%%B"
)
if not defined MAJ goto :eof
if %MAJ% GEQ 24 set "NODE_OK=1"
if %MAJ% EQU 22 if %MIN% GEQ %NODE_MIN_MINOR% set "NODE_OK=1"
goto :eof

rem ---------------------------------------------------------------------------
rem  :RefreshPath - pick up PATH changes made by an installer in this session
rem ---------------------------------------------------------------------------
:RefreshPath
set "MACHINE_PATH="
set "USER_PATH="
for /f "tokens=2,*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul ^| findstr /i "REG_"') do set "MACHINE_PATH=%%~B"
for /f "tokens=2,*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul ^| findstr /i "REG_"') do set "USER_PATH=%%~B"
rem  Additive on purpose: never drop entries the calling shell already had.
if defined MACHINE_PATH call set "PATH=%%PATH%%;%%MACHINE_PATH%%"
if defined USER_PATH call set "PATH=%%PATH%%;%%USER_PATH%%"
goto :eof

rem ---------------------------------------------------------------------------
rem  %1 = powershell (Windows PowerShell 5.1) or pwsh (PowerShell 7).
rem  Both exist => two independent policy stores; each is handled on its own.
rem
rem  Verification is "probe again with a fresh process", NOT string-matching the
rem  error text: Set-ExecutionPolicy exits 0 even when a Group Policy overrides
rem  it (it only prints a sentence about the override), and that sentence is
rem  localized. "Did the effective policy actually change?" is locale-proof.
rem ---------------------------------------------------------------------------
:PolicyCheck
set "PSEXE=%~1"
where %PSEXE% >nul 2>nul
if errorlevel 1 exit /b 0
call :PolicyQuery
if not defined POLICY exit /b 0
if /i "!POLICY!"=="RemoteSigned" exit /b 0
if /i "!POLICY!"=="Unrestricted" exit /b 0
if /i "!POLICY!"=="Bypass" exit /b 0
if /i "!POLICY!"=="AllSigned" goto :PolicyStricter
if /i "!POLICY!"=="Restricted" goto :PolicyTryFix
exit /b 0

:PolicyTryFix
echo [..] %PSEXE%: execution policy is Restricted -- allowing local scripts for this user ...
%PSEXE% -NoProfile -Command "Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force" >nul 2>nul
call :PolicyQuery
if /i "!POLICY!"=="RemoteSigned" (
  echo [ok] %PSEXE%: RemoteSigned ^(current user only^). If the terminal you already
  echo      have open still refuses, close it and open a new one.
  exit /b 0
)
echo [x] %PSEXE%: could not change it -- the effective policy is still !POLICY!
echo      A Group Policy overrides Set-ExecutionPolicy. Use  dsh.cmd  instead, or
echo      ask IT to allow locally-created scripts:
echo        Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
echo      Scope table for the report:
%PSEXE% -NoProfile -Command "Get-ExecutionPolicy -List"
set "POLICY_NOTE=1"
exit /b 0

:PolicyStricter
echo [x] %PSEXE%: execution policy is AllSigned, which also blocks npm's unsigned
echo      dsh.ps1 shim. Not loosening a deliberate setting for you. Either use
echo        dsh.cmd --version
echo      or decide yourself:
echo        Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
set "POLICY_NOTE=1"
exit /b 0

:PolicyQuery
set "POLICY="
for /f "delims=" %%P in ('%PSEXE% -NoProfile -Command "Get-ExecutionPolicy" 2^>nul') do set "POLICY=%%P"
exit /b 0
