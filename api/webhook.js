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
  return 'Ты — личный ИИ-секретарь владельца аккаунта. Отвечай кратко, по-человечески (1-2 предложения), что хозяин занят и ты передашь сообщение.';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Webhook active');
  }

  const { TELEGRAM_BOT_TOKEN, GEMINI_API_KEY } = process.env;

  if (!TELEGRAM_BOT_TOKEN || !GEMINI_API_KEY) {
    return res.status(200).json({ status: 'missing_keys' });
  }

  const update = req.body;
  if (!update) {
    return res.status(200).json({ status: 'no_body' });
  }

  // Получаем сообщение (прямое или из Telegram Business)
  const message = update.message || update.business_message;
  if (!message) {
    return res.status(200).json({ status: 'no_message' });
  }

  const businessConnId = message.business_connection_id;
  const chatId = message.chat?.id;
  const senderId = message.from?.id;

  // 1. ВАЖНО: Если это Telegram Business, проверяем, кто автор!
  // В приватном диалоге chat.id — это ID собеседника.
  // Если senderId !== chatId, значит сообщение отправил САМ ВЛАДЕЛЕЦ (или бот от его имени).
  // Ни в коем случае не отвечаем на исходящие сообщения владельца!
  if (businessConnId && senderId !== chatId) {
    return res.status(200).json({ status: 'ignored_outgoing_owner_message' });
  }

  // Игнорируем сообщения от ботов
  if (message.from?.is_bot) {
    return res.status(200).json({ status: 'ignored_bot' });
  }

  let userText = (message.text || message.caption || '').trim();
  const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;

  if (!userText && !hasPhoto) {
    return res.status(200).json({ status: 'no_text_or_photo' });
  }

  // Если это прямой диалог с ботом и команда /start
  if (!businessConnId && userText === '/start') {
    const welcome = "👋 Привет! Я личный ассистент на базе Gemini. Чем помочь?";
    await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, welcome);
    return res.status(200).json({ status: 'ok' });
  }

  try {
    sendTelegramAction(TELEGRAM_BOT_TOKEN, chatId, 'typing', businessConnId).catch(() => {});

    const parts = [];

    if (hasPhoto) {
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
        userText = 'Посмотри на фото и кратко ответь собеседнику.';
      }
    }

    parts.push({ text: userText });

    const systemPrompt = getSystemPrompt();
    
    // Пробуем доступные модели Gemini (сначала быструю 3.5-flash-lite, затем 3.1-flash-lite)
    const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
    let botReply = null;

    for (const model of modelsToTry) {
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
        const resp = await fetch(geminiUrl, {
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
              temperature: 0.6,
              maxOutputTokens: 150
            }
          })
        });

        if (resp.ok) {
          const data = await resp.json();
          botReply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (botReply) break;
        } else {
          console.warn(`Model ${model} returned status ${resp.status}`);
        }
      } catch (e) {
        console.warn(`Model ${model} failed:`, e.message);
      }
    }

    if (!botReply) {
      // Запасной лаконичный ответ, если Gemini временно недоступен
      botReply = "Привет! Я ИИ-помощник, хозяин сейчас не у телефона. Я зафиксировал сообщение и передам ему, как освободится.";
    }

    await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, botReply, businessConnId);

    return res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Webhook error:', error);
    // ВАЖНО: В режиме личных сообщений (Business) НИКОГДА не шлем технические ошибки в чат!
    return res.status(200).json({ status: 'error_suppressed' });
  }
}

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
    text: text
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
