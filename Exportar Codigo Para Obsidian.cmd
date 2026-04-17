@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao foi encontrado neste computador.
  echo Instale o Node e tente novamente.
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node scripts\exportar-repositorio-para-obsidian-md.js %*
echo.
echo Exportacao finalizada. Pressione qualquer tecla para fechar.
pause >nul
