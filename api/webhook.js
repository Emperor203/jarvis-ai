import fs from 'fs';
import path from 'path';

// Хранилище контекста диалогов
const chatHistories = new Map();

// Время последней активности владельца во ВСЕМ Telegram (глобально)
let lastGlobalOwnerActivity = 0;

// Если владелец отправлял хоть одно сообщение в Telegram менее 10 минут назад — считаем его ОНЛАЙН и бот МОЛЧИТ!
const ONLINE_COOLDOWN_MS = 10 * 60 * 1000;

function getSystemPrompt() {
  try {
    const kbPath = path.join(process.cwd(), 'knowledge_base.txt');
    if (fs.existsSync(kbPath)) {
      return fs.readFileSync(kbPath, 'utf-8');
    }
  } catch (err) {
    console.warn('Could not read knowledge_base.txt:', err);
  }
  return 'Ты живой, умный, настоящий собеседник в Telegram. Общайся свободно, легко, по-дружески, без шаблонов.';
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

  const message = update.message || update.business_message;
  if (!message) {
    return res.status(200).json({ status: 'no_message' });
  }

  const businessConnId = message.business_connection_id;
  const chatId = message.chat?.id;
  const senderId = message.from?.id;

  // 1. ЕСЛИ СООБЩЕНИЕ ОТПРАВИЛ САМ ВЛАДЕЛЕЦ:
  // (В бизнес-режиме: senderId !== chatId означает, что пишет владелец аккаунта)
  if (businessConnId && senderId !== chatId) {
    // Владелец прямо сейчас пишет в Telegram -> он ОНЛАЙН!
    lastGlobalOwnerActivity = Date.now();
    
    // Запоминаем реплику владельца в контекст
    const text = message.text || message.caption || '';
    if (text) {
      addHistoryTurn(chatId, 'model', text);
    }
    return res.status(200).json({ status: 'owner_sent_message_online_updated' });
  }

  // 2. ЖЕЛЕЗНОЕ ПРАВИЛО: ЕСЛИ ВЛАДЕЛЕЦ ОНЛАЙН — БОТ НЕ ОТВЕЧАЕТ!
  // Если владелец писал что-либо в Telegram в течение последних 10 минут — бот молчит!
  if (businessConnId) {
    const timeSinceLastOwnerAction = Date.now() - lastGlobalOwnerActivity;
    if (timeSinceLastOwnerAction < ONLINE_COOLDOWN_MS) {
      console.log(`[SILENCE] Owner was active ${Math.round(timeSinceLastOwnerAction / 1000)}s ago. Bot will not reply.`);
      return res.status(200).json({ status: 'owner_is_online_bot_silent' });
    }
  }

  // Игнорируем других ботов
  if (message.from?.is_bot) {
    return res.status(200).json({ status: 'ignored_bot' });
  }

  let userText = (message.text || message.caption || '').trim();
  const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;

  if (!userText && !hasPhoto) {
    return res.status(200).json({ status: 'no_text_or_photo' });
  }

  // Если это личный диалог с ботом
  if (!businessConnId && userText === '/start') {
    const welcome = "Салют! Я на связи. О чем поболтаем?";
    await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, welcome);
    return res.status(200).json({ status: 'ok' });
  }

  try {
    sendTelegramAction(TELEGRAM_BOT_TOKEN, chatId, 'typing', businessConnId).catch(() => {});

    const currentParts = [];

    if (hasPhoto) {
      const highestResPhoto = message.photo[message.photo.length - 1];
      const photoBase64 = await getTelegramFileBase64(TELEGRAM_BOT_TOKEN, highestResPhoto.file_id);
      if (photoBase64) {
        currentParts.push({
          inline_data: {
            mime_type: 'image/jpeg',
            data: photoBase64
          }
        });
      }
      if (!userText) {
        userText = 'Глянь на фото и отреагируй по-человечески.';
      }
    }

    currentParts.push({ text: userText });

    addHistoryTurn(chatId, 'user', userText);
    const contents = getHistoryContents(chatId, currentParts);

    const systemPrompt = getSystemPrompt();
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
            contents: contents,
            generationConfig: {
              temperature: 0.8,
              maxOutputTokens: 250
            }
          })
        });

        if (resp.ok) {
          const data = await resp.json();
          botReply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (botReply) break;
        }
      } catch (e) {
        console.warn(`Model ${model} error:`, e.message);
      }
    }

    if (!botReply) {
      return res.status(200).json({ status: 'no_reply_silence' });
    }

    addHistoryTurn(chatId, 'model', botReply);
    await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, botReply, businessConnId);

    return res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(200).json({ status: 'error_suppressed' });
  }
}

function addHistoryTurn(chatId, role, text) {
  if (!chatHistories.has(chatId)) {
    chatHistories.set(chatId, []);
  }
  const history = chatHistories.get(chatId);
  history.push({ role, text });
  if (history.length > 8) {
    history.shift();
  }
}

function getHistoryContents(chatId, currentParts) {
  const history = chatHistories.get(chatId) || [];
  const contents = [];

  for (let i = 0; i < history.length - 1; i++) {
    const item = history[i];
    contents.push({
      role: item.role,
      parts: [{ text: item.text }]
    });
  }

  contents.push({
    role: 'user',
    parts: currentParts
  });

  return contents;
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
