import zlib from 'zlib';

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
  </style>
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
${html}
  </div>
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
