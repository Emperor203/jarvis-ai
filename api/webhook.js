import fs from 'fs';
import path from 'path';

function getSystemPrompt() {
  try {
    const kbPath = path.join(process.cwd(), 'knowledge_base.txt');
    if (fs.existsSync(kbPath)) {
      return fs.readFileSync(kbPath, 'utf-8');
    }
  } catch (err) {
    console.warn('Could not read knowledge_base.txt:', err);
  }
  return 'Ты вежливый и полезный виртуальный ассистент-автоответчик в Telegram. Отвечай дружелюбно, профессионально и по делу.';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Telegram Webhook endpoint is active. Use POST for updates.');
  }

  const { TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, GEMINI_MODEL = 'gemini-3.5-flash' } = process.env;

  if (!TELEGRAM_BOT_TOKEN || !GEMINI_API_KEY) {
    return res.status(500).send('Environment variables not configured');
  }

  const update = req.body;
  if (!update) {
    return res.status(200).json({ status: 'ok' });
  }

  // Поддержка как обычных сообщений (message), так и Telegram Business (business_message)
  const message = update.message || update.business_message;
  if (!message || !message.text) {
    return res.status(200).json({ status: 'ok', detail: 'No text message' });
  }

  // Игнорируем собственные исходящие сообщения (если сообщение отправлено владельцем аккаунта)
  if (message.from && message.from.is_bot) {
    return res.status(200).json({ status: 'ignored_bot' });
  }

  const chatId = message.chat.id;
  const userText = message.text.trim();
  const userName = message.from?.first_name || 'клиент';
  const businessConnId = message.business_connection_id;

  // Ответ на /start (только если это прямой диалог с ботом)
  if (userText === '/start' && !businessConnId) {
    const welcomeText = 
      `👋 Здравствуйте, ${userName}!\n\n` +
      `Я виртуальный ассистент с искусственным интеллектом (Gemini).\n` +
      `Готов ответить на любые ваши вопросы и помочь вам.\n\n` +
      `Напишите ваш вопрос прямо сюда!`;
    await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, welcomeText, businessConnId);
    return res.status(200).json({ status: 'ok' });
  }

  try {
    sendTelegramAction(TELEGRAM_BOT_TOKEN, chatId, 'typing', businessConnId).catch(() => {});

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
      const errText = await geminiResponse.text();
      console.error('Gemini error:', geminiResponse.status, errText);
      throw new Error(`Gemini status ${geminiResponse.status}`);
    }

    const geminiData = await geminiResponse.json();
    const botReply = geminiData.candidates?.[0]?.content?.parts?.[0]?.text 
      || 'Извините, не удалось сформировать ответ. Попробуйте еще раз.';

    await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, botReply, businessConnId);

    return res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Handler error:', error);
    return res.status(200).json({ status: 'error', message: error.message });
  }
}

async function sendTelegramMessage(botToken, chatId, text, businessConnId = null) {
  const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown'
  };

  if (businessConnId) {
    payload.business_connection_id = businessConnId;
  }

  let response = await fetch(telegramUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    delete payload.parse_mode;
    await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }
}

async function sendTelegramAction(botToken, chatId, action, businessConnId = null) {
  const telegramUrl = `https://api.telegram.org/bot${botToken}/sendChatAction`;
  const payload = {
    chat_id: chatId,
    action: action
  };
  if (businessConnId) {
    payload.business_connection_id = businessConnId;
  }
  await fetch(telegramUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}
