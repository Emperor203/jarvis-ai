import json
import os
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler

def load_system_prompt():
    try:
        kb_path = os.path.join(os.getcwd(), "knowledge_base.txt")
        if os.path.exists(kb_path):
            with open(kb_path, "r", encoding="utf-8") as f:
                return f.read().strip()
    except Exception as e:
        print("Error reading knowledge_base.txt:", e)
    return "Ты вежливый виртуальный ассистент-автоответчик в Telegram."

def send_telegram_message(bot_token, chat_id, text):
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    payload = json.dumps({
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "Markdown"
    }).encode("utf-8")
    
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception:
        # Повторная попытка без Markdown, если была ошибка форматирования
        payload_plain = json.dumps({
            "chat_id": chat_id,
            "text": text
        }).encode("utf-8")
        req_plain = urllib.request.Request(url, data=payload_plain, headers={"Content-Type": "application/json"})
        try:
            urllib.request.urlopen(req_plain, timeout=10)
        except Exception as e:
            print("Telegram send error:", e)

def send_telegram_typing(bot_token, chat_id):
    url = f"https://api.telegram.org/bot{bot_token}/sendChatAction"
    payload = json.dumps({"chat_id": chat_id, "action": "typing"}).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass

def generate_gemini_reply(api_key, model, prompt, user_text):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    payload = json.dumps({
        "system_instruction": {
            "parts": [{"text": prompt}]
        },
        "contents": [
            {
                "role": "user",
                "parts": [{"text": user_text}]
            }
        ],
        "generationConfig": {
            "temperature": 0.7
        }
    }).encode("utf-8")
    
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        candidates = data.get("candidates", [])
        if candidates:
            parts = candidates[0].get("content", {}).get("parts", [])
            if parts:
                return parts[0].get("text", "")
    return "Не удалось получить ответ от нейросети."

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
        host = self.headers.get("x-forwarded-host") or self.headers.get("Host", "localhost")
        proto = self.headers.get("x-forwarded-proto", "https")
        webhook_url = f"{proto}://{host}/api/index"

        if "set-webhook" in self.path:
            if not bot_token:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"error": "TELEGRAM_BOT_TOKEN not configured"}')
                return

            tg_url = f"https://api.telegram.org/bot{bot_token}/setWebhook?url={urllib.parse.quote(webhook_url)}"
            try:
                with urllib.request.urlopen(tg_url, timeout=10) as resp:
                    tg_res = resp.read().decode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.end_headers()
                    res_body = json.dumps({
                        "status": "Webhook registration sent",
                        "webhook_url": webhook_url,
                        "telegram_response": json.loads(tg_res)
                    }, ensure_ascii=False)
                    self.wfile.write(res_body.encode("utf-8"))
                    return
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(str(e).encode("utf-8"))
                return

        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        html = f"""
        <h2>🤖 Jarvis AI Telegram Bot на Vercel</h2>
        <p>Статус: Работает!</p>
        <p><a href="/api/index?set-webhook=1">👉 Нажмите сюда, чтобы активировать Webhook бота</a></p>
        """
        self.wfile.write(html.encode("utf-8"))

    def do_POST(self):
        bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
        gemini_key = os.environ.get("GEMINI_API_KEY", "")
        gemini_model = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash")

        content_len = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_len).decode("utf-8")
        
        try:
            update = json.loads(body)
        except Exception:
            self.send_response(200)
            self.end_headers()
            return

        message = update.get("message")
        if not message or not message.get("text"):
            self.send_response(200)
            self.end_headers()
            return

        chat_id = message["chat"]["id"]
        user_text = message["text"].strip()
        first_name = message.get("from", {}).get("first_name", "друг")

        if user_text == "/start":
            welcome = (
                f"👋 Здравствуйте, {first_name}!\n\n"
                "Я виртуальный ассистент с искусственным интеллектом (Gemini).\n"
                "Готов ответить на любые ваши вопросы по услугам, ценам и помочь вам.\n\n"
                "Напишите ваш вопрос прямо сюда!"
            )
            send_telegram_message(bot_token, chat_id, welcome)
            self.send_response(200)
            self.end_headers()
            return

        send_telegram_typing(bot_token, chat_id)
        system_prompt = load_system_prompt()

        try:
            reply = generate_gemini_reply(gemini_key, gemini_model, system_prompt, user_text)
            send_telegram_message(bot_token, chat_id, reply)
        except Exception as e:
            print("Gemini processing error:", e)
            send_telegram_message(bot_token, chat_id, "⚠️ Временная ошибка нейросети. Попробуйте еще раз.")

        self.send_response(200)
        self.end_headers()
