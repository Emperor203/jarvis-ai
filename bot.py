import asyncio
import logging
import os
from collections import deque
from pathlib import Path
from dotenv import load_dotenv

from aiogram import Bot, Dispatcher, types, F
from aiogram.filters import Command, CommandStart
from aiogram.enums import ChatAction
from aiogram.utils.chat_action import ChatActionSender

from google import genai
from google.genai import types as genai_types

# Загружаем переменные окружения
load_dotenv()

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
MAX_HISTORY_LEN = int(os.getenv("MAX_HISTORY_LEN", "10"))

# Настройка логирования
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - [%(levelname)s] - %(name)s - %(message)s"
)
logger = logging.getLogger("telegram-gemini-bot")

# Чтение базы знаний / системного промпта
KNOWLEDGE_BASE_PATH = Path(__file__).parent / "knowledge_base.txt"

def load_system_prompt() -> str:
    if KNOWLEDGE_BASE_PATH.exists():
        with open(KNOWLEDGE_BASE_PATH, "r", encoding="utf-8") as f:
            return f.read().strip()
    return "Ты полезный ассистент-автоответчик в Telegram."

# Хранилище истории диалогов пользователей в памяти
# user_id -> deque of genai_types.Content
user_histories: dict[int, deque] = {}

def get_user_history(user_id: int) -> deque:
    if user_id not in user_histories:
        user_histories[user_id] = deque(maxlen=MAX_HISTORY_LEN * 2)
    return user_histories[user_id]

def clear_user_history(user_id: int):
    if user_id in user_histories:
        user_histories[user_id].clear()

# Инициализация Gemini
gemini_client = genai.Client(api_key=GEMINI_API_KEY)

# Инициализация aiogram
dp = Dispatcher()

@dp.message(CommandStart())
async def handle_start(message: types.Message):
    clear_user_history(message.from_user.id)
    welcome_text = (
        f"👋 Здравствуйте, {message.from_user.first_name}!\n\n"
        "Я виртуальный ассистент с искусственным интеллектом (Gemini).\n"
        "Готов ответить на любые ваши вопросы по услугам, графику работы, ценам и помочь вам.\n\n"
        "💡 *Команды:*\n"
        "• `/reset` или `/clear` — сбросить контекст диалога и начать сначала."
    )
    await message.answer(welcome_text, parse_mode="Markdown")

@dp.message(Command("reset"))
@dp.message(Command("clear"))
async def handle_reset(message: types.Message):
    clear_user_history(message.from_user.id)
    await message.answer("🔄 История нашего диалога очищена. Чем могу вам помочь?")

@dp.message(F.text)
async def handle_message(message: types.Message, bot: Bot):
    user_id = message.from_user.id
    user_text = message.text.strip()

    # Показываем статус "печатает..." в Telegram, пока нейросеть думает
    async with ChatActionSender.typing(bot=bot, chat_id=message.chat.id):
        try:
            history = get_user_history(user_id)
            system_prompt = load_system_prompt()

            # Добавляем входящее сообщение пользователя
            user_content = genai_types.Content(
                role="user",
                parts=[genai_types.Part.from_text(text=user_text)]
            )
            history.append(user_content)

            # Формируем список сообщений для отправки в модель
            contents = list(history)

            # Вызываем Gemini API асинхронно через executor, чтобы не блокировать event loop
            loop = asyncio.get_running_loop()
            response = await loop.run_in_executor(
                None,
                lambda: gemini_client.models.generate_content(
                    model=GEMINI_MODEL,
                    contents=contents,
                    config=genai_types.GenerateContentConfig(
                        system_instruction=system_prompt,
                        temperature=0.7,
                    )
                )
            )

            bot_reply = response.text or "К сожалению, не удалось сгенерировать ответ. Попробуйте еще раз."

            # Запоминаем ответ модели в историю
            model_content = genai_types.Content(
                role="model",
                parts=[genai_types.Part.from_text(text=bot_reply)]
            )
            history.append(model_content)

            # Отправляем ответ пользователю (учитывая лимит Telegram в 4096 символов)
            if len(bot_reply) <= 4000:
                try:
                    await message.answer(bot_reply, parse_mode="Markdown")
                except Exception:
                    # Если разметка Markdown не прошла валидацию, шлем обычным текстом
                    await message.answer(bot_reply)
            else:
                # Разбиваем длинный текст на части
                for i in range(0, len(bot_reply), 4000):
                    chunk = bot_reply[i:i + 4000]
                    await message.answer(chunk)

        except Exception as e:
            logger.error(f"Ошибка при обработке запроса: {e}", exc_info=True)
            await message.answer(
                "⚠️ Произошла ошибка при обращении к нейросети. "
                "Пожалуйста, повторите попытку через пару секунд."
            )

async def main():
    if not TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN == "YOUR_TELEGRAM_BOT_TOKEN_HERE":
        logger.error("❌ TELEGRAM_BOT_TOKEN не указан в файле .env!")
        print("\n[!] ОШИБКА: Откройте файл .env и вставьте токен вашего бота от @BotFather в переменную TELEGRAM_BOT_TOKEN\n")
        return

    bot = Bot(token=TELEGRAM_BOT_TOKEN)
    logger.info(f"🚀 Запуск Telegram-бота с Gemini ({GEMINI_MODEL})...")
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
