@echo off
cd /d "%~dp0"

if "%~1"=="" (
  bun index.ts serve on
) else (
  bun index.ts %*
)
