@echo off
chcp 65001 > nul
echo ==================================================
echo   Запуск Telegram-бота автоответчика (Gemini AI)
echo ==================================================
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo [!] Ошибка: виртуальное окружение .venv не найдено!
    pause
    exit /b
)

echo Запуск бота... Для остановки нажмите Ctrl+C.
.venv\Scripts\python.exe bot.py
pause
