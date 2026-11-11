import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { SFX_SCRIPT } from '../lib/sfx.js';

// Хранилище контекста диалогов и текущего языка чата
const chatHistories = new Map();
const chatLanguages = new Map();

function detectAndLockChatLanguage(chatId, text) {
  const clean = (text || '').trim();
  const prevLang = chatLanguages.get(chatId) || 'ru';

  // Явные маркеры узбекского языка (узбекская кириллица или явные узбекские фразы)
  const hasUzbekCyrillic = /[ўқғҳ]/i.test(clean);
  const uzbekLatinMatches = clean.match(/\b(salom|assalomu|qalay|qaleysan|qanday|nima|gaplar|menga|sen|men|uchun|bilan|kerak|bo'ldi|yaxshi|rahmat|yoz|qilib|ber|yig'ib|o'zbek|o'zbekcha|aka|uka)\b/gi);
  const wordCount = clean.split(/\s+/).filter(Boolean).length;

  if (hasUzbekCyrillic || (uzbekLatinMatches && (uzbekLatinMatches.length >= 2 || (uzbekLatinMatches.length === 1 && wordCount >= 2 && !/[а-яё]/i.test(clean))))) {
    chatLanguages.set(chatId, 'uz');
    return 'uz';
  }

  // Явные маркеры русского языка (кириллица без узбекских букв)
  if (/[а-яё]{3,}/i.test(clean) && !hasUzbekCyrillic) {
    chatLanguages.set(chatId, 'ru');
    return 'ru';
  }

  // Короткие неоднозначные слова ("Alo", "Ok", "123", стикеры/эмодзи) НЕ меняют язык диалога!
  return prevLang;
}

let cachedKb = null;

function getSystemPrompt(isHeavyTask = true) {
  if (!isHeavyTask) {
    return 'Ты — живой, умный собеседник Jarvis в Telegram. Отвечай коротко (1–2 живых предложения), естественно, без занудства и без фраз «передам хозяину».';
  }
  if (cachedKb) return cachedKb;
  try {
    const kbPath = path.join(process.cwd(), 'knowledge_base.txt');
    if (fs.existsSync(kbPath)) {
      cachedKb = fs.readFileSync(kbPath, 'utf-8');
      return cachedKb;
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

  // Обработка нажатия кнопки «📁 Файлом для друга» (экспорт HTML игры)
  if (update.callback_query?.data === 'export_html') {
    await handleExportHtmlCallback(TELEGRAM_BOT_TOKEN, update.callback_query);
    return res.status(200).json({ status: 'exported_html' });
  }

  const message = update.message || update.business_message;
  if (!message) {
    return res.status(200).json({ status: 'no_message' });
  }

  const businessConnId = message.business_connection_id;
  const chatId = message.chat?.id;
  const senderId = message.from?.id;

  // 1. ИГНОРИРУЕМ ИСХОДЯЩИЕ СООБЩЕНИЯ САМОГО ВЛАДЕЛЬЦА:
  // Если пишет сам владелец — бот просто запоминает реплику в контекст и не отвечает самому себе.
  if (businessConnId && senderId !== chatId) {
    const text = message.text || message.caption || '';
    if (text) {
      addHistoryTurn(chatId, 'model', text);
    }
    return res.status(200).json({ status: 'ignored_outgoing' });
  }

  // 2. НА ВСЕ ВХОДЯЩИЕ СООБЩЕНИЯ БОТ ОТВЕЧАЕТ МОМЕНТАЛЬНО (БЕЗ ЗАДЕРЖЕК)!

  // Игнорируем других ботов
  if (message.from?.is_bot) {
    return res.status(200).json({ status: 'ignored_bot' });
  }

  let userText = (message.text || message.caption || '').trim();
  const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
  const videoObj = message.video || message.video_note || message.animation;
  const hasVideo = Boolean(videoObj);

  if (!userText && !hasPhoto && !hasVideo) {
    return res.status(200).json({ status: 'no_text_or_media' });
  }

  // Если это личный диалог с ботом
  if (!businessConnId && userText === '/start') {
    const welcome = "Салют! Я на связи. Пиши, кидай фото или видео — поболтаем!";
    await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, welcome);
    return res.status(200).json({ status: 'ok' });
  }

  try {
    sendTelegramAction(TELEGRAM_BOT_TOKEN, chatId, 'typing', businessConnId).catch(() => {});

    const currentParts = [];

    if (hasPhoto) {
      const highestResPhoto = message.photo[message.photo.length - 1];
      const photoBuffer = await getTelegramFileBuffer(TELEGRAM_BOT_TOKEN, highestResPhoto.file_id);
      if (photoBuffer) {
        currentParts.push({
          inline_data: {
            mime_type: 'image/jpeg',
            data: photoBuffer.toString('base64')
          }
        });
      }
      if (!userText) {
        userText = 'Глянь на фото и отреагируй по-человечески.';
      }
    }

    if (hasVideo) {
      const MAX_TELEGRAM_BYTES = 20 * 1024 * 1024;
      const INLINE_VIDEO_LIMIT = 12 * 1024 * 1024;

      if (videoObj.file_size && videoObj.file_size > MAX_TELEGRAM_BYTES) {
        await sendTelegramMessage(
          TELEGRAM_BOT_TOKEN,
          chatId,
          'Видео тяжелее 20 МБ, Telegram не дает мне его скачать 😅 Скинь ролик покороче или сожми — с радостью посмотрю!',
          businessConnId
        );
        return res.status(200).json({ status: 'video_too_large' });
      }

      const videoBuffer = await getTelegramFileBuffer(TELEGRAM_BOT_TOKEN, videoObj.file_id);
      if (!videoBuffer) {
        return res.status(200).json({ status: 'video_download_failed' });
      }

      const mimeType = videoObj.mime_type || 'video/mp4';

      if (videoBuffer.length <= INLINE_VIDEO_LIMIT) {
        currentParts.push({
          inline_data: {
            mime_type: mimeType,
            data: videoBuffer.toString('base64')
          }
        });
      } else {
        const fileUri = await uploadToGeminiFilesAPI(GEMINI_API_KEY, videoBuffer, mimeType);
        if (!fileUri) {
          return res.status(200).json({ status: 'video_upload_failed' });
        }
        currentParts.push({
          file_data: {
            mime_type: mimeType,
            file_uri: fileUri
          }
        });
      }

      if (!userText) {
        userText = 'Посмотри это видео (и послушай, что там говорят) и отреагируй по-человечески.';
      }
    }

    currentParts.push({ text: userText });

    addHistoryTurn(chatId, 'user', userText);
    const contents = getHistoryContents(chatId, currentParts);

    const activeLang = detectAndLockChatLanguage(chatId, userText);
    const langDirective = activeLang === 'uz'
      ? '\n\nТЕКУЩИЙ ЯЗЫК ДИАЛОГА: УЗБЕКСКИЙ. Отвечай строго только на узбекском языке!'
      : '\n\nТЕКУЩИЙ ЯЗЫК ДИАЛОГА: РУССКИЙ. Отвечай строго ТОЛЬКО на русском языке, даже если прислали короткое слово на латинице вроде "Alo" или "Ok".';

    // Обычная болтовня идет по сверхбыстрому пути; игры, код, фото и видео — по мощному
    const isHeavyTask = hasPhoto || hasVideo || /(игр|сделай|создай|напиши|приложен|терминал|код|html|css|python|скрипт|виджет|кликер|змейк|гонк|шахмат|тетрис|матриц|бонсай|2048|калькулятор|таймер|доработ|добавь|измени|почини|исправ|сайт|мини-?апп|мини-?игр|game|app|code|\bjs\b)/i.test(userText);

    const systemPrompt = getSystemPrompt(isHeavyTask) + langDirective;
    const modelsToTry = isHeavyTask
      ? [
          { id: 'gemini-3.5-flash', noThinking: true, timeout: 18000 },
          { id: 'gemini-3.5-flash-lite', noThinking: false, timeout: 15000 },
          { id: 'gemini-3.8-flash', noThinking: true, timeout: 18000 },
          { id: 'gemini-3.1-flash-lite', noThinking: false, timeout: 15000 }
        ]
      : [
          { id: 'gemini-3.5-flash-lite', noThinking: false, timeout: 6000 },
          { id: 'gemini-3.5-flash', noThinking: true, timeout: 8000 },
          { id: 'gemini-3.1-flash-lite', noThinking: false, timeout: 8000 }
        ];
    let botReply = null;

    for (const modelCfg of modelsToTry) {
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelCfg.id}:generateContent?key=${GEMINI_API_KEY}`;
        const genConfig = {
          temperature: 0.7,
          maxOutputTokens: isHeavyTask ? 4096 : 350
        };
        if (modelCfg.noThinking) {
          genConfig.thinkingConfig = { thinkingBudget: 0 };
        }

        const resp = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(modelCfg.timeout),
          body: JSON.stringify({
            system_instruction: {
              parts: [{ text: systemPrompt }]
            },
            contents: contents,
            generationConfig: genConfig
          })
        });

        if (resp.ok) {
          const data = await resp.json();
          const parts = data.candidates?.[0]?.content?.parts || [];
          // Собираем ВСЕ текстовые части ответа (исключая внутренние мысли thought)
          botReply = parts
            .filter(p => !p.thought && typeof p.text === 'string')
            .map(p => p.text)
            .join('')
            .trim();
          if (botReply) break;
        }
      } catch (e) {
        console.warn(`Model ${modelCfg.id} error:`, e.message);
      }
    }

    if (!botReply) {
      return res.status(200).json({ status: 'no_reply_silence' });
    }

    // Проверяем, сгенерировал ли бот интерактивную игру/приложение (<telegram_widget> или <telegram_app>)
    const gameMatch = botReply.match(/<telegram_(?:widget|app|game)[^>]*>([\s\S]*?)<\/telegram_(?:widget|app|game)>/i);
    if (gameMatch) {
      let gameHtml = gameMatch[1].trim();
      gameHtml = gameHtml.replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/i, '').trim();

      const textOutside = botReply.replace(gameMatch[0], '').trim() || 'Готово! Запускай на весь экран 👇';
      addHistoryTurn(chatId, 'model', `${textOutside} [Отправлена кнопка запуска]`);

      const host = req.headers['x-forwarded-host'] || req.headers.host || 'jarvis-ai-bice-one.vercel.app';
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const cleanForUrl = gameHtml
        .replace(/\0/g, '')
        .replace(/\b(\d+)vh\b/gi, '$1%')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\n\s+/g, '\n')
        .trim();

      // Сжимаем Brotli (на 25-30% плотнее deflate)
      const encodedGame = zlib.brotliCompressSync(Buffer.from(cleanForUrl, 'utf-8'), {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 }
      }).toString('base64url');
      const fullScreenUrl = `${proto}://${host}/api/play?b=${encodedGame}`;

      let sentButton = false;
      if (!businessConnId && encodedGame.length <= 13000) {
        const btnRes = await sendTelegramWebAppButton(TELEGRAM_BOT_TOKEN, chatId, textOutside, fullScreenUrl);
        sentButton = Boolean(btnRes?.ok);
      }

      if (!sentButton) {
        // Никогда не кидаем длинный base64-текст в чат — отправляем готовый HTML-файл!
        await sendTelegramDocument(TELEGRAM_BOT_TOKEN, chatId, cleanForUrl, 'app.html', textOutside, businessConnId);
      }
    } else {
      addHistoryTurn(chatId, 'model', botReply);
      await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, botReply, businessConnId);
    }

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

async function getTelegramFileBuffer(botToken, fileId) {
  try {
    const fileInfoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
    const fileInfoResp = await fetch(fileInfoUrl);
    const fileInfo = await fileInfoResp.json();

    if (!fileInfo.ok || !fileInfo.result?.file_path) {
      return null;
    }

    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;
    const fileResp = await fetch(downloadUrl);
    if (!fileResp.ok) return null;
    const arrayBuffer = await fileResp.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.error('Error fetching file from Telegram:', err);
    return null;
  }
}

async function uploadToGeminiFilesAPI(apiKey, buffer, mimeType) {
  try {
    const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=media&key=${apiKey}`;
    const uploadResp = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': mimeType },
      body: buffer
    });

    if (!uploadResp.ok) {
      console.error('Gemini File API upload failed:', uploadResp.status);
      return null;
    }

    const uploadData = await uploadResp.json();
    let file = uploadData.file;
    if (!file) return null;

    // Если видео в состоянии PROCESSING — ждем пока станет ACTIVE (до 15 сек)
    const maxAttempts = 15;
    for (let i = 0; i < maxAttempts && file.state === 'PROCESSING'; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const checkResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}?key=${apiKey}`);
      if (checkResp.ok) {
        file = await checkResp.json();
      }
    }

    return file.state === 'ACTIVE' ? file.uri : null;
  } catch (err) {
    console.error('Error uploading to Gemini Files API:', err);
    return null;
  }
}

async function sendTelegramMessage(botToken, chatId, text, businessConnId = null) {
  const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  
  const chunks = splitTextIntoChunks(text, 4000);

  for (const chunk of chunks) {
    const payload = {
      chat_id: chatId,
      text: chunk,
      parse_mode: 'Markdown'
    };

    if (businessConnId) {
      payload.business_connection_id = businessConnId;
    }

    let resp = await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    // Если разметка Markdown дала сбой — шлем чистым текстом, чтобы сообщение не потерялось
    if (!resp.ok) {
      delete payload.parse_mode;
      await fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
  }
}

function splitTextIntoChunks(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf('\n', maxLen);
    if (splitIndex === -1 || splitIndex < maxLen / 2) {
      splitIndex = maxLen;
    }
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }
  return chunks;
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

async function sendTelegramWebAppButton(botToken, chatId, text, webAppUrl) {
  try {
    const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const shareRow = [];

    if (webAppUrl.length <= 1800) {
      const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(webAppUrl)}&text=${encodeURIComponent('Зацени игру от Jarvis! 🎮')}`;
      shareRow.push({ text: '📤 Поделиться ссылкой', url: shareUrl });
      shareRow.push({ text: '📁 Файлом', callback_data: 'export_html' });
    } else {
      shareRow.push({ text: '📤 Поделиться с другом (файл)', callback_data: 'export_html' });
    }

    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🎮 Запустить на весь экран',
              web_app: { url: webAppUrl }
            }
          ],
          shareRow
        ]
      }
    };

    let resp = await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    let data = await resp.json();
    if (!data.ok && String(data.description || '').includes('parse entities')) {
      delete payload.parse_mode;
      resp = await fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      data = await resp.json();
    }
    return data;
  } catch (err) {
    console.error('sendTelegramWebAppButton error:', err);
    return { ok: false, description: err.message };
  }
}

async function handleExportHtmlCallback(botToken, cq) {
  try {
    // Отвечаем на нажатие кнопки, чтобы убрать часики
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: cq.id, text: 'Готовлю файл для пересылки...' })
    });

    const rows = cq.message?.reply_markup?.inline_keyboard || [];
    let webAppUrl = null;
    for (const row of rows) {
      for (const btn of row) {
        if (btn.web_app?.url) {
          webAppUrl = btn.web_app.url;
          break;
        }
      }
      if (webAppUrl) break;
    }

    if (!webAppUrl) return;

    const urlObj = new URL(webAppUrl);
    const b = urlObj.searchParams.get('b');
    const g = urlObj.searchParams.get('g');
    let html = '';

    if (b) {
      html = zlib.brotliDecompressSync(Buffer.from(b, 'base64url')).toString('utf-8');
    } else if (g) {
      html = zlib.inflateRawSync(Buffer.from(g, 'base64url')).toString('utf-8');
    }

    if (!html) return;

    await sendTelegramDocument(
      botToken,
      cq.message.chat.id,
      html,
      'jarvis_game.html',
      'Перешли этот файл другу — откроется на любом телефоне и ПК! 🎮'
    );
  } catch (err) {
    console.error('handleExportHtmlCallback error:', err);
  }
}

async function sendTelegramDocument(botToken, chatId, htmlContent, filename, caption, businessConnId = null) {
  try {
    const fullDoc = `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">${SFX_SCRIPT}</head><body style="margin:0;padding:0;width:100vw;height:100vh;background:#111822;color:#fff;overflow:hidden;">${htmlContent}</body></html>`;
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (businessConnId) {
      form.append('business_connection_id', businessConnId);
    }
    if (caption) {
      form.append('caption', caption.slice(0, 1000));
    }
    form.append('document', new Blob([fullDoc], { type: 'text/html' }), filename);

    await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: 'POST',
      body: form
    });
  } catch (err) {
    console.error('sendTelegramDocument error:', err);
  }
}
