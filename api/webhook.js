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
  return 'Ты вежливый и полезный виртуальный ассистент-автоответчик в Telegram. Ты умеешь анализировать как текст, так и фотографии, скриншоты, чеки и изображения товаров. Отвечай дружелюбно, профессионально и по делу.';
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

  // Поддержка обычных сообщений (message) и Telegram Business (business_message)
  const message = update.message || update.business_message;
  if (!message) {
    return res.status(200).json({ status: 'ok' });
  }

  // Игнорируем собственные исходящие сообщения от ботов
  if (message.from && message.from.is_bot) {
    return res.status(200).json({ status: 'ignored_bot' });
  }

  const chatId = message.chat.id;
  const businessConnId = message.business_connection_id;
  const userName = message.from?.first_name || 'клиент';

  // Проверяем наличие текста или подписи к фото
  let userText = (message.text || message.caption || '').trim();
  const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;

  if (!userText && !hasPhoto) {
    return res.status(200).json({ status: 'ok', detail: 'Unsupported message type' });
  }

  // Ответ на /start (только в прямом диалоге)
  if (userText === '/start' && !businessConnId && !hasPhoto) {
    const welcomeText = 
      `👋 Здравствуйте, ${userName}!\n\n` +
      `Я виртуальный ассистент с искусственным интеллектом (Gemini).\n` +
      `Я понимаю текстовые сообщения, а также **могу просматривать фотографии, скриншоты, товары и чеки**!\n\n` +
      `Напишите вопрос или пришлите фото, и я помогу вам.`;
    await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, welcomeText, businessConnId);
    return res.status(200).json({ status: 'ok' });
  }

  try {
    sendTelegramAction(TELEGRAM_BOT_TOKEN, chatId, 'typing', businessConnId).catch(() => {});

    // Формируем контент для Gemini
    const parts = [];

    // Если прислали фото — скачиваем его и передаем в Gemini как base64
    if (hasPhoto) {
      // Берем самое высокое разрешение (последний элемент массива photo)
      const highestResPhoto = message.photo[message.photo.length - 1];
      const photoBase64 = await getTelegramFileBase64(TELEGRAM_BOT_TOKEN, highestResPhoto.file_id);
      
      if (photoBase64) {
        parts.push({
          inline_data: {
            mime_type: 'image/jpeg',
            data: photoBase64
          }
        });
      }

      if (!userText) {
        userText = 'Посмотри на изображение и подробно проанализируй его. Ответь и подскажи клиенту.';
      }
    }

    parts.push({ text: userText });

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
            parts: parts
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
      || 'Извините, не удалось проанализировать сообщение. Попробуйте еще раз.';

    await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, botReply, businessConnId);

    return res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Handler error:', error);
    await sendTelegramMessage(
      TELEGRAM_BOT_TOKEN, 
      chatId, 
      '⚠️ Извините, не удалось обработать запрос. Пожалуйста, попробуйте еще раз.',
      businessConnId
    ).catch(() => {});
    return res.status(200).json({ status: 'error', message: error.message });
  }
}

// Загрузка фото из Telegram и конвертация в base64
async function getTelegramFileBase64(botToken, fileId) {
  try {
    const fileInfoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
    const fileInfoResp = await fetch(fileInfoUrl);
    const fileInfo = await fileInfoResp.json();

    if (!fileInfo.ok || !fileInfo.result?.file_path) {
      return null;
    }

    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;
    const imageResp = await fetch(downloadUrl);
    const arrayBuffer = await imageResp.arrayBuffer();
    return Buffer.from(arrayBuffer).toString('base64');
  } catch (err) {
    console.error('Error fetching photo from Telegram:', err);
    return null;
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
