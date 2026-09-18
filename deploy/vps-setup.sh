#!/bin/bash
# ============================================================
#  Установка YouTube Trend Radar на чистый Ubuntu VPS
#  Использование:  bash vps-setup.sh   (запускать от root)
# ============================================================
set -e

APP_DIR="/opt/trend"
SERVICE_NAME="trend"

echo "🚀 Установка YouTube Trend Radar"
echo ""

# ─── 0. Проверка прав ────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  echo "❌ Запусти скрипт от root: sudo bash vps-setup.sh"
  exit 1
fi

# ─── 1. Обновление системы и базовые пакеты ──────────────────
echo "📦 Шаг 1/5: Обновление системы..."
apt-get update -qq
apt-get install -y -qq curl git > /dev/null

# ─── 2. Установка Node.js 20 ─────────────────────────────────
echo "📦 Шаг 2/5: Установка Node.js 20..."
if ! command -v node > /dev/null 2>&1 || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null
fi
echo "   ✅ Node.js $(node -v)"

# ─── 3. Загрузка кода ────────────────────────────────────────
echo "📥 Шаг 3/5: Загрузка кода из GitHub..."
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR"
  git pull --ff-only
else
  rm -rf "$APP_DIR"
  git clone --depth 1 https://github.com/lexxgreat/trend.git "$APP_DIR"
  cd "$APP_DIR"
fi
npm install --omit=dev --no-audit --no-fund > /dev/null 2>&1
echo "   ✅ Код загружен: $APP_DIR"

# ─── 4. Настройка ключа API ──────────────────────────────────
echo "🔑 Шаг 4/5: Настройка YOUTUBE_API_KEY..."
if [ ! -f .env ]; then
  echo ""
  read -rp "   Вставь свой ключ YouTube API: " API_KEY
  echo "YOUTUBE_API_KEY=$API_KEY" > .env
  chmod 600 .env
  echo "   ✅ Ключ сохранён в $APP_DIR/.env"
else
  echo "   ✅ .env уже существует — пропускаю"
fi

# ─── 5. Сервис systemd (автозапуск + автоперезапуск) ─────────
echo "⚙️  Шаг 5/5: Настройка автозапуска..."
cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=YouTube Trend Radar
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=$(command -v node) ${APP_DIR}/server.mjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME} > /dev/null 2>&1
systemctl restart ${SERVICE_NAME}
sleep 3

# ─── Итог ────────────────────────────────────────────────────
PUBLIC_IP=$(curl -4 -s --max-time 5 ifconfig.me || hostname -I | awk '{print $1}')
STATUS=$(systemctl is-active ${SERVICE_NAME})
echo ""
if [ "$STATUS" = "active" ]; then
  echo "✅✅✅ ВСЁ ГОТОВО! ✅✅✅"
  echo ""
  echo "   🌐 Твой сайт:  http://${PUBLIC_IP}:3000"
  echo "   📋 Логи:       journalctl -u ${SERVICE_NAME} -f"
  echo "   🔄 Перезапуск: systemctl restart ${SERVICE_NAME}"
  echo ""
  echo "   Сайт работает 24/7 и перезапускается сам после сбоев."
else
  echo "⚠️  Сервис не запустился. Смотри логи:"
  echo "   journalctl -u ${SERVICE_NAME} -n 30 --no-pager"
  exit 1
fi
