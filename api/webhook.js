import fs from 'fs';
import path from 'path';

// Загрузка системного промпта / базы знаний
function getSystemPrompt() {
  try {
    const kbPath = path.join(process.cwd(), 'knowledge_base.txt');
    if (fs.existsSync(kbPath)) {
      return fs.readFileSync(kbPath, 'utf-8');
    }
  } catch (err) {
    console.warn('Could not read knowledge_base.txt:', err);
  }
  return 'Ты вежливый и полезный автоответчик в Telegram. Отвечай дружелюбно и по делу.';
}

export default async function handler(req, res) {
  // Telegram Webhook отправляет только POST запросы
  if (req.method !== 'POST') {
    return res.status(200).send('Telegram Webhook endpoint is active. Use POST for updates.');
  }

  const { TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, GEMINI_MODEL = 'gemini-3.5-flash' } = process.env;

  if (!TELEGRAM_BOT_TOKEN || !GEMINI_API_KEY) {
    console.error('Missing TELEGRAM_BOT_TOKEN or GEMINI_API_KEY');
    return res.status(500).send('Environment variables not configured');
  }

  const update = req.body;

  // Проверяем, есть ли текстовое сообщение
  if (!update || !update.message || !update.message.text) {
    return res.status(200).json({ status: 'ok', detail: 'No text message to process' });
  }

  const chatId = update.message.chat.id;
  const userText = update.message.text.trim();
  const userName = update.message.from?.first_name || 'друг';

  // Обработка команды /start
  if (userText === '/start') {
    const welcomeText = 
      `👋 Здравствуйте, ${userName}!\n\n` +
      `Я виртуальный ассистент с искусственным интеллектом (Gemini).\n` +
      `Готов ответить на любые ваши вопросы по услугам, графику работы, ценам и помочь вам.\n\n` +
      `Просто напишите ваш вопрос сюда!`;
    await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, welcomeText);
    return res.status(200).json({ status: 'ok' });
  }

  try {
    // Отправляем индикатор набора текста ("печатает...")
    sendTelegramAction(TELEGRAM_BOT_TOKEN, chatId, 'typing').catch(() => {});

    // Запрос к Google Gemini API
    const systemPrompt = getSystemPrompt();
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const geminiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: userText }]
          }
        ],
        generationConfig: {
          temperature: 0.7
        }
      })
    });

    if (!geminiResponse.ok) {
      const errBody = await geminiResponse.text();
      console.error('Gemini API Error:', geminiResponse.status, errBody);
      throw new Error(`Gemini error: ${geminiResponse.status}`);
    }

    const geminiData = await geminiResponse.json();
    const botReply = geminiData.candidates?.[0]?.content?.parts?.[0]?.text 
      || 'Извините, не удалось сформировать ответ. Попробуйте еще раз.';

    // Отправляем ответ в Telegram
    await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, botReply);

    return res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Handler error:', error);
    await sendTelegramMessage(
      TELEGRAM_BOT_TOKEN, 
      chatId, 
      '⚠️ Извините, произошла временная ошибка при обработке запроса. Пожалуйста, попробуйте еще раз.'
    ).catch(() => {});
    return res.status(200).json({ status: 'error', message: error.message });
  }
}

// Вспомогательная функция отправки сообщения в Telegram
async function sendTelegramMessage(botToken, chatId, text) {
  const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  
  // Пробуем отправить с Markdown, если не выйдет — отправляем чистым текстом
  let response = await fetch(telegramUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    })
  });

  if (!response.ok) {
    await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text
      })
    });
  }
}

// Вспомогательная функция отправки статуса печати
async function sendTelegramAction(botToken, chatId, action) {
  const telegramUrl = `https://api.telegram.org/bot${botToken}/sendChatAction`;
  await fetch(telegramUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      action: action
    })
  });
}
