import zlib from 'zlib';

export default function handler(req, res) {
  const { g } = req.query;
  if (!g || typeof g !== 'string') {
    return res.status(400).send('Game payload missing');
  }

  try {
    const html = zlib.inflateRawSync(Buffer.from(g, 'base64url')).toString('utf-8');

    const fullPage = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Jarvis Game</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: var(--tg-theme-bg-color, #17212b);
      color: var(--tg-theme-text-color, #ffffff);
    }
  </style>
  <script>
    try {
      const tg = window.Telegram && window.Telegram.WebApp;
      if (tg) {
        tg.ready();
        tg.expand();
        if (typeof tg.requestFullscreen === 'function') {
          tg.requestFullscreen();
        }
      }
    } catch (e) {}
  </script>
</head>
<body>
${html}
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
