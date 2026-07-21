@echo off
REM Launcher for the Zanzibar flight watcher. Point Windows Task Scheduler at
REM this file. Uses the absolute node path so it works even when the scheduler
REM runs with a minimal PATH.

set NODE_EXE=C:\Program Files\nodejs\node.exe
if not exist "%NODE_EXE%" set NODE_EXE=node

"%NODE_EXE%" "%~dp0watch.mjs" %*
