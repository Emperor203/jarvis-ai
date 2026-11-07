# 🤖 Jarvis AI — Telegram-автоответчик с Gemini AI (Деплой на Vercel)

Умный автоответчик для Telegram на базе **Google Gemini AI**, готовый для мгновенного бесплатного деплоя на **Vercel** 24/7 (Serverless Webhook).

---

## 🚀 Деплой на Vercel за 2 минуты

1. **Создайте проект на Vercel:**
   - Зайдите на [vercel.com](https://vercel.com)
   - Нажмите **Add New...** ➜ **Project**
   - Выберите репозиторий **jarvis-ai** из вашего GitHub.

2. **Добавьте переменные окружения (Environment Variables):**
   - `TELEGRAM_BOT_TOKEN` = `ваш_токен_от_BotFather`
   - `GEMINI_API_KEY` = `ваш_ключ_Gemini_API`
   - `GEMINI_MODEL` = `gemini-3.5-flash`

3. **Нажмите Deploy**
   - Vercel за 10-15 секунд соберет проект и выдаст адрес (например: `https://jarvis-ai-xxx.vercel.app`).

4. **Активируйте Webhook:**
   - Откройте в браузере ссылку:
     `https://<ваш-домен>.vercel.app/api/set-webhook`
   - Вы увидите подтверждение: `"description": "Webhook was set"`.
   - Всё! Теперь бот отвечает клиентам в Telegram 24/7 без включенного ноутбука.

---

## ⚙️ Настройка роли и базы знаний
Файл `knowledge_base.txt` содержит инструкции для ИИ, правила, график работы и FAQ. Вы можете редактировать его прямо на GitHub — Vercel автоматически применит изменения!
