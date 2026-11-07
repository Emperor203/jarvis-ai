export default async function handler(req, res) {
  const { TELEGRAM_BOT_TOKEN } = process.env;

  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN is not set' });
  }

  // Получаем хост текущего развернутого проекта на Vercel
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const webhookUrl = `${protocol}://${host}/api/webhook`;

  try {
    const telegramApi = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;
    const response = await fetch(telegramApi);
    const data = await response.json();

    return res.status(200).json({
      message: 'Telegram Webhook registration result',
      webhookUrl: webhookUrl,
      telegramResponse: data
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
