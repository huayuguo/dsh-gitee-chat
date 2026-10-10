@echo off
rem ===========================================================================
rem  uninstall-dsh.cmd -- remove DSH + Node.js and restore the stock PowerShell
rem  execution policy. The reset counterpart of install-dsh.cmd, for testing
rem  the installer on a machine you own.
rem
rem  Usage:
rem      scripts\uninstall-dsh.cmd                  (remove everything)
rem      scripts\uninstall-dsh.cmd --keep-node      (keep Node.js, remove DSH)
rem
rem  What it does, the reverse of install-dsh.cmd:
rem    - npm uninstall -g @deepseek-ai/dsh (the three shims go with it)
rem    - winget uninstall Node.js LTS, the same ID install-dsh.cmd installs;
rem      machine-wide, so a UAC prompt may appear (--keep-node skips this)
rem    - delete the folders the install leaves behind:
rem        the npm global prefix  (usually %APPDATA%\npm: ALL global packages,
rem                                  incl. the pnpm install-dsh.cmd installs)
rem        the npm cache            (usually %LOCALAPPDATA%\npm-cache)
rem        the DSH home             (usually %USERPROFILE%\.dsh: profiles,
rem                                  plugin installs, doc caches, tokens)
rem    - undo the execution-policy lift install-dsh.cmd may have applied:
rem      CurrentUser RemoteSigned back to Undefined, so the effective policy
rem      falls back to the stock client default (Restricted: no .ps1 runs)
rem
rem  Narrow on purpose, mirroring install-dsh.cmd:
rem    - only the RemoteSigned that install-dsh.cmd sets is undone. A
rem      CurrentUser policy that is anything else was chosen on purpose and is
rem      left alone, with the manual command printed. One honest caveat: a
rem      CurrentUser RemoteSigned that predates install-dsh.cmd cannot be
rem      told apart from ours -- if it was yours, set it again afterwards.
rem    - this repository is never touched. Re-clone it for a pristine tree.
rem
rem  Why .cmd instead of .ps1: same reason as install-dsh.cmd -- the stock
rem  policy refuses .ps1 files, and this script must run on machines where
rem  that policy is exactly what needs restoring.
rem
rem  ASCII-only on purpose: a non-ASCII .cmd garbles under the legacy console
rem  code page (936/GBK). Keep every message in English.
rem ===========================================================================

setlocal EnableExtensions EnableDelayedExpansion
set "KEEP_NODE="
if /i "%~1"=="--keep-node" set "KEEP_NODE=1"
if /i "%~1"=="keep-node" set "KEEP_NODE=1"
set "FAILED="

echo.
echo === DSH uninstaller (Windows) ===
echo.
if defined KEEP_NODE echo [..] --keep-node: Node.js will be kept.

rem --- refresh PATH in THIS session (Machine + User), see :RefreshPath ---------
call :RefreshPath

rem --- 1) ask npm for its folders NOW, while Node is still here ----------------
set "NPM_PREFIX="
set "NPM_CACHE="
where npm >nul 2>nul
if errorlevel 1 goto :NpmDefaults
for /f "delims=" %%P in ('npm prefix -g 2^>nul') do set "NPM_PREFIX=%%P"
for /f "delims=" %%C in ('npm config get cache 2^>nul') do set "NPM_CACHE=%%C"

:NpmDefaults
if not defined NPM_PREFIX set "NPM_PREFIX=%APPDATA%\npm"
if not defined NPM_CACHE set "NPM_CACHE=%LOCALAPPDATA%\npm-cache"
set "PATH=%NPM_PREFIX%;%PATH%"

rem --- 2) remove the global DSH package -----------------------------------------
set "DSH_PRESENT="
where dsh >nul 2>nul
if not errorlevel 1 set "DSH_PRESENT=1"
if not defined DSH_PRESENT if exist "%NPM_PREFIX%\dsh.cmd" set "DSH_PRESENT=1"
if not defined DSH_PRESENT if exist "%NPM_PREFIX%\node_modules\@deepseek-ai\dsh" set "DSH_PRESENT=1"
if defined DSH_PRESENT goto :DshRemove
echo [ok] dsh is not installed.
goto :NodePart

:DshRemove
where npm >nul 2>nul
if not errorlevel 1 goto :DshNpm
echo [..] npm is not available, so the package is not uninstalled cleanly.
echo      The prefix folder deletion in step 4 still removes its files.
goto :NodePart

:DshNpm
echo [..] removing the global npm package @deepseek-ai/dsh ...
call npm uninstall -g @deepseek-ai/dsh
if errorlevel 1 goto :DshFail
where dsh >nul 2>nul
if errorlevel 1 goto :DshOk
echo [x] dsh is still on PATH, so it lives outside npm's global prefix:
where dsh
echo      Remove that install yourself, then run this script again.
set "FAILED=1"
goto :NodePart

:DshFail
echo [x] npm uninstall failed.
set "FAILED=1"
goto :NodePart

:DshOk
echo [ok] dsh removed.

:NodePart
rem --- 3) Node.js -----------------------------------------------------------------
if defined KEEP_NODE goto :FolderPart
where node >nul 2>nul
if errorlevel 1 goto :NodeAbsent
where winget >nul 2>nul
if errorlevel 1 goto :NoWinget
echo [..] uninstalling Node.js via winget, a UAC prompt may appear ...
call winget uninstall --id OpenJS.NodeJS.LTS -e
if errorlevel 1 goto :NodeFail
where node >nul 2>nul
if errorlevel 1 goto :NodeOk
echo [x] node is still reachable in this window. The uninstall may not have
echo      fully applied. Open a NEW terminal and check with:  where node
set "FAILED=1"
goto :FolderPart

:NodeAbsent
echo [ok] Node.js is not installed.
goto :FolderPart

:NoWinget
echo [x] winget is not available, so this script cannot remove Node.js.
echo      Uninstall it by hand: Settings, Apps, installed apps, Node.js.
echo      The remaining steps below still run.
set "FAILED=1"
goto :FolderPart

:NodeFail
echo [x] winget uninstall failed.
echo      Uninstall it by hand: Settings, Apps, installed apps, Node.js.
set "FAILED=1"
goto :FolderPart

:NodeOk
echo [ok] Node.js removed.

:FolderPart
rem --- 4) delete the folders --------------------------------------------------------
if not defined DSH_HOME set "DSH_HOME=%USERPROFILE%\.dsh"
call :RemoveFolder "%NPM_PREFIX%" "the npm global prefix, all global packages"
call :RemoveFolder "%NPM_CACHE%" "the npm cache"
call :RemoveFolder "%DSH_HOME%" "the DSH home"

rem --- 5) restore the stock PowerShell execution policy -----------------------------
call :PolicyRestore powershell
call :PolicyRestore pwsh

rem --- 6) what to do next -----------------------------------------------------------
for %%I in ("%~dp0..") do set "REPO_DIR=%%~fI"
echo.
if defined FAILED goto :FailOut
if defined KEEP_NODE goto :DoneKeep
echo [ok] Done. DSH, Node.js and the folders above are gone, and the policy
echo      lift from install-dsh.cmd is undone. A policy that was not ours was
echo      left alone. Open a NEW terminal for a fully clean state.
goto :DoneHint

:DoneKeep
echo [ok] Done. DSH and the folders above are gone, Node.js was kept, and the
echo      policy lift from install-dsh.cmd is undone. Open a NEW terminal for
echo      a fully clean state.

:DoneHint
echo.
echo      Re-test the installer with:
echo        %REPO_DIR%\scripts\install-dsh.cmd
echo.
endlocal
exit /b 0

:FailOut
echo.
echo [x] Not finished. Fix the [x] points above, then run this script again.
echo.
endlocal
exit /b 1

rem ---------------------------------------------------------------------------
rem  Rebuild PATH for THIS session from the registry. (Same as install-dsh.cmd.)
rem ---------------------------------------------------------------------------
:RefreshPath
set "MACHINE_PATH="
set "USER_PATH="
for /f "tokens=2,*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul ^| find "REG_"') do set "MACHINE_PATH=%%B"
for /f "tokens=2,*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul ^| find "REG_"') do set "USER_PATH=%%B"
if defined MACHINE_PATH if defined USER_PATH call set "PATH=%MACHINE_PATH%;%USER_PATH%"
if defined MACHINE_PATH if not defined USER_PATH call set "PATH=%MACHINE_PATH%"
exit /b 0

rem ---------------------------------------------------------------------------
rem  %1 = folder path, %2 = short description. Deletes the folder if present.
rem
rem  Flat on purpose, no parenthesized blocks: %-expansion happens when a
rem  block is PARSED, so a closing paren inside an expanded value would end
rem  the block mid-echo. Delayed !vars! are safe everywhere and used throughout.
rem  The two guards refuse anything that is not an absolute X:\subpath, so a
rem  drive root or a stray relative value can never be deleted.
rem ---------------------------------------------------------------------------
:RemoveFolder
set "RF_PATH=%~1"
set "RF_WHAT=%~2"
if not defined RF_PATH exit /b 0
set "RF_DRIVE=!RF_PATH:~1,1!"
if not "!RF_DRIVE!"==":" goto :RFRefuse
set "RF_TAIL=!RF_PATH:~3!"
if defined RF_TAIL goto :RFGo

:RFRefuse
echo [x] refusing to delete, path looks unsafe: !RF_PATH!
set "FAILED=1"
exit /b 1

:RFGo
if exist "!RF_PATH!" goto :RFDelete
echo [ok] %RF_WHAT%: not present.
exit /b 0

:RFDelete
echo [..] deleting %RF_WHAT%:
echo      !RF_PATH!
rd /s /q "!RF_PATH!" >nul 2>nul
if not exist "!RF_PATH!" goto :RFOk
echo [x] could not delete it. Close any running  dsh web  or  node  process
echo      that may hold files open, then run this script again.
set "FAILED=1"
exit /b 1

:RFOk
echo [ok] deleted.
exit /b 0

rem ---------------------------------------------------------------------------
rem  %1 = powershell (Windows PowerShell 5.1) or pwsh (PowerShell 7).
rem  Both exist => two independent policy stores; each is handled on its own.
rem
rem  install-dsh.cmd only ever lifts the STOCK Restricted to CurrentUser
rem  RemoteSigned. The exact reverse: CurrentUser RemoteSigned back to
rem  Undefined, which drops the scope back to the stock default (Restricted
rem  on a Windows client: no .ps1 runs). A CurrentUser policy that is anything
rem  else was not ours, and is left alone.
rem
rem  Verification re-probes with a FRESH process, never string-matches error
rem  text: Set-ExecutionPolicy exits 0 even when a Group Policy overrides it,
rem  and that sentence is localized. Scope values are enum names, always
rem  English, so the check is locale-proof.
rem ---------------------------------------------------------------------------
:PolicyRestore
set "PSEXE=%~1"
where %PSEXE% >nul 2>nul
if errorlevel 1 exit /b 0
call :ScopeQuery
if not defined POLICY_SCOPE exit /b 0
if /i "!POLICY_SCOPE!"=="Undefined" goto :PRAlready
if /i "!POLICY_SCOPE!"=="RemoteSigned" goto :PRUndo
echo [..] %PSEXE%: the CurrentUser policy is !POLICY_SCOPE!, which is not what
echo      install-dsh.cmd sets, so it was not touched. Undo it yourself with:
echo        Set-ExecutionPolicy -Scope CurrentUser Undefined
goto :PRDone

:PRAlready
echo [ok] %PSEXE%: the CurrentUser policy is already Undefined. Nothing to restore.
goto :PRDone

:PRUndo
echo [..] %PSEXE%: restoring CurrentUser RemoteSigned back to Undefined ...
%PSEXE% -NoProfile -Command "Set-ExecutionPolicy -Scope CurrentUser Undefined -Force" >nul 2>nul
call :ScopeQuery
if /i "!POLICY_SCOPE!"=="Undefined" goto :PRCheck
echo [x] %PSEXE%: could not restore it, CurrentUser is still !POLICY_SCOPE!.
echo      A Group Policy overrides Set-ExecutionPolicy. Undo it yourself with:
echo        Set-ExecutionPolicy -Scope CurrentUser Undefined
echo      Scope table for the report:
%PSEXE% -NoProfile -Command "Get-ExecutionPolicy -List"
set "FAILED=1"
goto :PRDone

:PRCheck
rem  Fresh-process probe of the EFFECTIVE policy, to say what is in force now.
set "EFFECTIVE="
for /f "delims=" %%E in ('%PSEXE% -NoProfile -Command "Get-ExecutionPolicy" 2^>nul') do set "EFFECTIVE=%%E"
if /i "!EFFECTIVE!"=="Restricted" goto :PRStock
echo [ok] %PSEXE%: CurrentUser is Undefined. The effective policy is !EFFECTIVE!,
echo      set by a scope this script never touches (MachinePolicy, UserPolicy or
echo      LocalMachine). It predates install-dsh.cmd, so it stays as it is.
goto :PRDone

:PRStock
echo [ok] %PSEXE%: CurrentUser is Undefined. The effective policy is Restricted,
echo      the stock Windows client default: no .ps1 runs from now on.

:PRDone
exit /b 0

:ScopeQuery
set "POLICY_SCOPE="
for /f "delims=" %%P in ('%PSEXE% -NoProfile -Command "Get-ExecutionPolicy -Scope CurrentUser" 2^>nul') do set "POLICY_SCOPE=%%P"
exit /b 0
