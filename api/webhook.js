import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

// Хранилище контекста диалогов
const chatHistories = new Map();

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

  // Обработка запросов из интерактивных виджетов (Bot API 10.4)
  if (update.widget_query) {
    await answerTelegramWidgetQuery(TELEGRAM_BOT_TOKEN, update.widget_query.id).catch(() => {});
    return res.status(200).json({ status: 'widget_query_answered' });
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

    const systemPrompt = getSystemPrompt();
    const modelsToTry = [
      { id: 'gemini-3.5-flash', noThinking: true },
      { id: 'gemini-3.5-flash-lite', noThinking: false },
      { id: 'gemini-3.8-flash', noThinking: true },
      { id: 'gemini-3.1-flash-lite', noThinking: false }
    ];
    let botReply = null;

    for (const modelCfg of modelsToTry) {
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelCfg.id}:generateContent?key=${GEMINI_API_KEY}`;
        const genConfig = {
          temperature: 0.7,
          maxOutputTokens: 4096
        };
        if (modelCfg.noThinking) {
          genConfig.thinkingConfig = { thinkingBudget: 0 };
        }

        const resp = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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

    // Проверяем, сгенерировал ли бот интерактивный виджет <telegram_widget>
    const widgetMatch = botReply.match(/<telegram_widget([^>]*)>([\s\S]*?)<\/telegram_widget>/i);
    if (widgetMatch) {
      const attrs = widgetMatch[1] || '';
      let widgetHtml = widgetMatch[2].trim();
      // Убираем случайные ```html ... ``` внутри тега
      widgetHtml = widgetHtml.replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/i, '').trim();

      const widthMatch = attrs.match(/width=["']?(\d+)["']?/i);
      const heightMatch = attrs.match(/height=["']?(\d+)["']?/i);
      // Всегда ставим максимальную ширину виджета (600, Telegram сам подгонит под ширину экрана)
      const width = widthMatch ? Math.max(parseInt(widthMatch[1], 10), 480) : 600;
      const height = heightMatch ? Math.min(Math.max(parseInt(heightMatch[1], 10), 460), 600) : 540;

      const textOutside = botReply.replace(widgetMatch[0], '').trim();
      addHistoryTurn(chatId, 'model', textOutside ? `${textOutside} [Отправлен интерактивный виджет]` : '[Отправлен интерактивный виджет]');

      if (textOutside) {
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, textOutside, businessConnId);
      }

      const widgetResult = await sendTelegramWidget(TELEGRAM_BOT_TOKEN, chatId, widgetHtml, width, height, businessConnId);
      if (!widgetResult.ok) {
        console.warn('sendWidget failed:', widgetResult.description);
        // Если это Business-чат (где Telegram может ограничивать виджеты) или превышен размер
        if (businessConnId) {
          await sendTelegramMessage(
            TELEGRAM_BOT_TOKEN,
            chatId,
            `⚠️ Интерактивные виджеты Telegram пока работают только в личке самого бота (@jarvis_otvet_bot). Отправляю кодом:\n\n\`\`\`html\n${widgetHtml}\n\`\`\``,
            businessConnId
          );
        } else {
          await sendTelegramMessage(
            TELEGRAM_BOT_TOKEN,
            chatId,
            `⚠️ Не удалось запустить виджет (${widgetResult.description || 'ограничение размера 4 КБ'}). Вот готовый HTML-код:\n\n\`\`\`html\n${widgetHtml}\n\`\`\``
          );
        }
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

async function sendTelegramWidget(botToken, chatId, html, width = 600, height = 540, businessConnId = null) {
  try {
    // Заменяем запрещенные в виджетах единицы vh на %, убираем NUL-байты и задаем полную ширину/высоту
    const baseReset = '<style>html,body{margin:0;padding:0;width:100%;height:100%;box-sizing:border-box;overflow:hidden;}</style>';
    let cleanHtml = baseReset + html
      .replace(/\0/g, '')
      .replace(/\b(\d+)vh\b/gi, '$1%');

    // Если сжатый виджет превышает 4096 байт, аккуратно сжимаем пробелы и пустые строки
    if (zlib.deflateSync(cleanHtml, { level: 9 }).length > 4096) {
      cleanHtml = cleanHtml
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\n\s+/g, '\n')
        .trim();
    }

    const telegramUrl = `https://api.telegram.org/bot${botToken}/sendWidget`;
    const payload = {
      chat_id: chatId,
      html: cleanHtml
    };

    if (width >= 200 && width <= 600) {
      payload.width = width;
    }
    if (height >= 50 && height <= 600) {
      payload.height = height;
    }
    if (businessConnId) {
      payload.business_connection_id = businessConnId;
    }

    const resp = await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await resp.json();
    return data;
  } catch (err) {
    console.error('sendTelegramWidget error:', err);
    return { ok: false, description: err.message };
  }
}

async function answerTelegramWidgetQuery(botToken, widgetQueryId) {
  const telegramUrl = `https://api.telegram.org/bot${botToken}/answerWidgetQuery`;
  await fetch(telegramUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ widget_query_id: widgetQueryId })
  });
}
