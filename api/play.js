import zlib from 'zlib';
import { SFX_SCRIPT } from '../lib/sfx.js';

export default function handler(req, res) {
  const { g, b } = req.query;
  if ((!g || typeof g !== 'string') && (!b || typeof b !== 'string')) {
    return res.status(400).send('Game payload missing');
  }

  try {
    const html = b
      ? zlib.brotliDecompressSync(Buffer.from(b, 'base64url')).toString('utf-8')
      : zlib.inflateRawSync(Buffer.from(g, 'base64url')).toString('utf-8');

    const fullPage = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>Jarvis Game</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    * {
      box-sizing: border-box;
      -webkit-tap-highlight-color: transparent;
    }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      overscroll-behavior: none;
      touch-action: none;
      background: var(--tg-theme-bg-color, #111822);
      color: var(--tg-theme-text-color, #ffffff);
      display: flex;
      justify-content: center;
      align-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    #mobile-shell {
      width: 100%;
      max-width: 500px;
      height: 100%;
      padding-top: calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px));
      padding-bottom: max(var(--tg-safe-area-inset-bottom, 0px), 8px);
      padding-left: var(--tg-safe-area-inset-left, 0px);
      padding-right: var(--tg-safe-area-inset-right, 0px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #jarvis-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      font-size: 13px;
      flex-shrink: 0;
    }
    #jarvis-brand {
      opacity: 0.75;
      font-weight: 600;
    }
    #jarvis-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #sound-btn {
      background: rgba(255,255,255,0.1);
      color: var(--tg-theme-text-color, #ffffff);
      border: none;
      border-radius: 8px;
      padding: 5px 9px;
      font-size: 13px;
      cursor: pointer;
    }
    #share-btn {
      background: var(--tg-theme-button-color, #3b82f6);
      color: var(--tg-theme-button-text-color, #ffffff);
      border: none;
      border-radius: 8px;
      padding: 5px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    #game-root {
      flex: 1;
      width: 100%;
      min-height: 0;
      position: relative;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
  </style>
  ${SFX_SCRIPT}
  <script>
    try {
      const tg = window.Telegram && window.Telegram.WebApp;
      if (tg) {
        tg.ready();
        tg.expand();
        if (typeof tg.disableVerticalSwipes === 'function') {
          tg.disableVerticalSwipes();
        }
        if (typeof tg.requestFullscreen === 'function') {
          tg.requestFullscreen();
        }
      }
    } catch (e) {}
  </script>
</head>
<body>
  <div id="mobile-shell">
    <div id="jarvis-bar">
      <span id="jarvis-brand">⚡ Jarvis</span>
      <div id="jarvis-actions">
        <button id="sound-btn" type="button" title="Звук">🔊</button>
        <button id="share-btn" type="button">📤 Поделиться</button>
      </div>
    </div>
    <div id="game-root">
${html}
    </div>
  </div>
  <script>
    (function() {
      const sfxBtn = document.getElementById('sound-btn');
      if (sfxBtn && window.SFX) {
        sfxBtn.textContent = window.SFX.muted ? '🔇' : '🔊';
        sfxBtn.addEventListener('click', function() {
          const isMuted = window.SFX.toggle();
          sfxBtn.textContent = isMuted ? '🔇' : '🔊';
          if (!isMuted) window.SFX.click();
        });
      }
      const btn = document.getElementById('share-btn');
      if (!btn) return;
      btn.addEventListener('click', async function() {
        const gameUrl = window.location.href;
        const shareLink = 'https://t.me/share/url?url=' + encodeURIComponent(gameUrl) + '&text=' + encodeURIComponent('Зацени игру! 🎮');
        try {
          const tg = window.Telegram && window.Telegram.WebApp;
          if (gameUrl.length <= 2000 && tg && typeof tg.openTelegramLink === 'function') {
            tg.openTelegramLink(shareLink);
            return;
          }
          if (navigator.share) {
            await navigator.share({ title: 'Игра от Jarvis', url: gameUrl });
            return;
          }
        } catch (e) {}
        try {
          await navigator.clipboard.writeText(gameUrl);
          btn.textContent = '✅ Скопировано!';
          setTimeout(() => { btn.textContent = '📤 Поделиться'; }, 2000);
        } catch (e) {
          btn.textContent = '📁 Скачай файлом в чате';
          setTimeout(() => { btn.textContent = '📤 Поделиться'; }, 2500);
        }
      });
    })();
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).send(fullPage);
  } catch (err) {
    console.error('Error decoding game:', err);
    return res.status(400).send('Invalid game data');
  }
}
