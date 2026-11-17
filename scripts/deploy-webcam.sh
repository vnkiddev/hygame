#!/usr/bin/env bash
# Deploy webcam.vnkid.dev (thư mục webcam/) lên máy chủ LAN.
#
#     bash scripts/deploy-webcam.sh
#
# Trang tĩnh, chạy bằng webcam/serve.py dưới PM2 (tên "webcam", cổng 6010),
# cloudflared đã trỏ webcam.vnkid.dev về cổng đó.
#
# Cloudflare cache .js/.css tới 4 tiếng, nên mỗi lần deploy gắn ?v=<mã nội dung>
# vào đường dẫn lib/*.js|css trong các trang HTML (HTML thì Cloudflare không cache).
# Chỉ sửa bản trên máy chủ, mã nguồn trong repo giữ nguyên.
set -euo pipefail

SERVER=${SERVER:-192.168.102.15}
SSH_USER=${SSH_USER:-tnt}
SSH_PASS=${SSH_PASS:-1}
DIR=$(cd "$(dirname "$0")/.." && pwd)/webcam
SSH="sshpass -p $SSH_PASS ssh -o StrictHostKeyChecking=no $SSH_USER@$SERVER"

VER=$(cat "$DIR"/lib/* | shasum | cut -c1-8)
sshpass -p "$SSH_PASS" rsync -az --delete --exclude .port \
	-e "ssh -o StrictHostKeyChecking=no" "$DIR/" "$SSH_USER@$SERVER:~/apps/webcam/"

$SSH "
  set -e
  cd ~/apps/webcam
  find . -name '*.html' -exec sed -i -E 's#(lib/[a-z0-9_-]+\.(js|css))(\?v=[a-z0-9]+)?\"#\1?v=$VER\"#g' {} +
  # serve.py thêm header Cache-Control; khởi động lại để nạp bản mới của chính nó
  pm2 delete webcam >/dev/null 2>&1 || true
  pm2 start python3 --name webcam --interpreter none -- \$HOME/apps/webcam/serve.py \$(cat .port 2>/dev/null || echo 6010) >/dev/null
  pm2 save >/dev/null 2>&1 || true
  sleep 1
  curl -fsS -o /dev/null http://localhost:\$(cat .port 2>/dev/null || echo 6010)/
"
echo "✅ webcam.vnkid.dev đã cập nhật (v=$VER)"
