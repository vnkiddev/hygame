#!/usr/bin/env bash
# Deploy hygame lên máy chủ LAN nhà (192.168.102.15) theo quy ước của
# skill local-deploy, nhưng chỉnh cho app Python/FastAPI thay vì Node.
#
# CHẠY TRÊN MÁY MAC (máy có trong LAN):
#     bash scripts/deploy-lan.sh
# hoặc lấy thẳng từ GitHub, không cần có sẵn mã nguồn:
#     curl -fsSL https://raw.githubusercontent.com/vnkiddev/hygame/claude/spec-video-rewards-5j3xrb/scripts/deploy-lan.sh | bash
#
# Chạy lại nhiều lần vô hại: lần sau chính là lệnh cập nhật.
set -euo pipefail

SERVER=${SERVER:-192.168.102.15}
SSH_USER=${SSH_USER:-tnt}
SSH_PASS=${SSH_PASS:-1}
APP=${APP:-hygame}
SUB=${SUB:-hygame}
REPO=${REPO:-https://github.com/vnkiddev/hygame.git}
BRANCH=${BRANCH:-claude/spec-video-rewards-5j3xrb}
CF_CONFIG=/etc/cloudflared/config.yml

say()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;31m!! %s\033[0m\n' "$*"; }
die()  { warn "$*"; exit 1; }

command -v sshpass >/dev/null || die "Thiếu sshpass. Cài: brew install hudochenkov/sshpass/sshpass"
SSH="sshpass -p $SSH_PASS ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 $SSH_USER@$SERVER"

say "0/6 Kiểm tra kết nối tới $SERVER"
$SSH "echo ok" >/dev/null 2>&1 || die "Không SSH được vào $SSH_USER@$SERVER. Máy Mac có cùng LAN không?"

# --- chọn cổng ------------------------------------------------------------
say "1/6 Chọn cổng trống trong dải 6000-7000"
PORT=$($SSH "
  used=\$(ss -tlnH 2>/dev/null | awk '{print \$4}' | sed 's/.*://' | sort -un)
  # Tính cả cổng đã đặt chỗ trong cloudflared, tránh đụng app đang tắt
  reserved=\$(grep -oE 'localhost:[0-9]+' $CF_CONFIG 2>/dev/null | cut -d: -f2)
  taken=\$(printf '%s\n%s\n' \"\$used\" \"\$reserved\" | sort -un)
  for p in \$(seq 6000 7000); do
    echo \"\$taken\" | grep -qx \"\$p\" || { echo \$p; break; }
  done")
[ -n "$PORT" ] || die "Không tìm được cổng trống"
echo "    -> cổng $PORT"

# Cổng cũ của chính app này (nếu deploy lại) thì giữ nguyên, khỏi phải
# sửa cloudflared và khỏi đổi link LAN mà bố mẹ đã lưu.
OLD_PORT=$($SSH "grep -A1 'hostname: $SUB.vnkid.dev' $CF_CONFIG 2>/dev/null | grep -oE 'localhost:[0-9]+' | cut -d: -f2" || true)
if [ -n "$OLD_PORT" ]; then
	PORT=$OLD_PORT
	echo "    -> đã có cấu hình cũ, dùng lại cổng $PORT"
fi

# --- mã nguồn -------------------------------------------------------------
say "2/6 Mã nguồn -> ~/apps/$APP"
$SSH "
  set -e
  mkdir -p ~/apps
  if [ -d ~/apps/$APP/.git ]; then
    cd ~/apps/$APP && git fetch -q origin $BRANCH && git reset -q --hard origin/$BRANCH
  else
    git clone -q --branch $BRANCH $REPO ~/apps/$APP
  fi
  mkdir -p ~/apps/$APP/{models,data,kids}"

# --- môi trường Python ----------------------------------------------------
say "3/6 Môi trường Python (lần đầu hơi lâu)"
$SSH "
  set -e
  cd ~/apps/$APP
  command -v python3 >/dev/null || { echo '1' | sudo -S apt-get install -y -qq python3 python3-venv; }
  [ -d .venv ] || python3 -m venv .venv
  .venv/bin/pip install -q -U pip
  .venv/bin/pip install -q -r backend/requirements.txt"

# --- cấu hình -------------------------------------------------------------
say "4/6 Cấu hình"
$SSH "
  set -e
  cd ~/apps/$APP
  if [ ! -f .env ]; then
    echo \"ADMIN_TOKEN=\$(head -c 15 /dev/urandom | base64 | tr -d '/+=')\" > .env
    # Qua cloudflared thì request tới từ 127.0.0.1; trong LAN thì từ 192.168.x.
    # Cả hai đều nằm trong dải mặc định nên không cần đụng ALLOWED_NETS.
    echo 'ASR_THREADS=2' >> .env
    chmod 600 .env
  fi
  # kids/ không nằm trong git -> máy chủ mới clone sẽ trống, gieo sẵn 3 bé
  .venv/bin/python scripts/seed_kids.py"
TOKEN=$($SSH "grep ADMIN_TOKEN ~/apps/$APP/.env | cut -d= -f2")

# --- chạy app -------------------------------------------------------------
say "5/6 Khởi động (cổng $PORT)"
# Bind 0.0.0.0 chứ không phải 127.0.0.1, nếu không thì LAN vào không được.
$SSH "
  set -e
  cd ~/apps/$APP
  set -a; . ./.env; set +a
  if command -v pm2 >/dev/null; then
    if pm2 describe $APP >/dev/null 2>&1; then
      pm2 delete $APP >/dev/null
    fi
    # --interpreter none: uvicorn là script Python, đừng để pm2 gọi bằng node
    pm2 start .venv/bin/uvicorn --name $APP --interpreter none -- \
      backend.main:app --host 0.0.0.0 --port $PORT >/dev/null
    pm2 save >/dev/null 2>&1 || true
    echo '    -> chạy bằng PM2'
  else
    # Dừng tiến trình cũ theo PID đã ghi, KHÔNG dò theo mẫu dòng lệnh:
    # mẫu đó khớp luôn chính dòng lệnh ssh đang chạy nó, phiên ssh sẽ tự
    # giết mình và deploy treo giữa chừng.
    # Giải phóng cổng theo TIẾN TRÌNH ĐANG NGHE, không chỉ theo file PID:
    # file PID có thể cũ hoặc mất (ai đó chạy tay), khi ấy tiến trình cũ vẫn
    # giữ cổng, uvicorn mới chết vì Address already in use, mà health check
    # lại trúng server CŨ -> deploy báo thành công trong khi code cũ vẫn chạy.
    HOLDERS=\$(ss -tlnpH 2>/dev/null | grep \":$PORT \" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)
    OLDPID=\$(cat app.pid 2>/dev/null || true)
    for pid in \$HOLDERS \$OLDPID; do
      kill \"\$pid\" 2>/dev/null || true
    done
    [ -n \"\$HOLDERS\$OLDPID\" ] && sleep 2
    # </dev/null + chuyển hướng cả stdout/stderr: nếu không, ssh sẽ chờ mãi
    # vì tiến trình con vẫn giữ ống dữ liệu của phiên.
    nohup .venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port $PORT \
      < /dev/null > ~/apps/$APP/app.log 2>&1 &
    echo \$! > app.pid
    sleep 3
    if grep -q 'Address already in use' app.log 2>/dev/null; then
      tail -5 app.log
      echo 'CONG_BAN'
      exit 1
    fi
    echo '    -> chạy bằng nohup'
  fi"

say "   Đợi model nạp xong…"
HEALTH=""
for i in $(seq 1 20); do
	sleep 3
	HEALTH=$($SSH "curl -fsS -m 5 http://localhost:$PORT/api/health 2>/dev/null" || true)
	[ -n "$HEALTH" ] && break
done
[ -n "$HEALTH" ] || {
	$SSH "tail -25 ~/apps/$APP/app.log 2>/dev/null || pm2 logs $APP --lines 25 --nostream 2>/dev/null"
	die "App không lên được"
}
echo "    $HEALTH"

# --- cloudflared ----------------------------------------------------------
say "6/6 Cloudflared ($SUB.vnkid.dev)"
if [ -n "$OLD_PORT" ]; then
	echo "    -> đã có sẵn ingress, bỏ qua"
else
	$SSH "echo '$SSH_PASS' | sudo -S sed -i '/- service: http_status:404/i\\  - hostname: $SUB.vnkid.dev\\n    service: http://localhost:$PORT' $CF_CONFIG" 2>/dev/null
	$SSH "echo '$SSH_PASS' | sudo -S systemctl restart cloudflared" 2>/dev/null
	sleep 3
	CF=$($SSH "systemctl is-active cloudflared")
	[ "$CF" = "active" ] || warn "cloudflared đang ở trạng thái: $CF"
fi

printf '\n\033[1;32m════════════════════════════════════════════════\033[0m\n'
printf '  Link LAN:      \033[1mhttp://%s:%s/app/\033[0m\n' "$SERVER" "$PORT"
printf '  Trang bố mẹ:   \033[1mhttp://%s:%s/app/admin.html\033[0m\n' "$SERVER" "$PORT"
printf '  Qua internet:  \033[1mhttps://%s.vnkid.dev/app/\033[0m\n' "$SUB"
printf '  Mã quản trị:   \033[1m%s\033[0m\n' "$TOKEN"
printf '\033[1;32m════════════════════════════════════════════════\033[0m\n'
echo "$HEALTH" | grep -q '"warm":true' \
	|| printf '\n\033[1;31m!! Chưa có model ONNX -> máy chủ chưa nghe được.\n   Trò chơi vẫn chơi được bằng Web Speech API của trình duyệt.\n   Muốn có ASR máy chủ: xem deploy/install.md mục 3.\033[0m\n'
printf '\n\033[1;31m!! Micro cần secure origin. Link LAN dùng http:// nên Safari/Chrome\n   sẽ CHẶN micro. Muốn thử giọng nói thì vào bằng https://%s.vnkid.dev\033[0m\n' "$SUB"
