#!/usr/bin/env bash
# Cài/cập nhật trên chính máy chủ. Chạy bằng sudo trên máy đó:
#
#     curl -fsSL <raw-url>/scripts/deploy.sh | sudo bash
# hoặc, khi đã có mã nguồn:
#     sudo bash scripts/deploy.sh
#
# Chạy lại nhiều lần vô hại: chỉ cập nhật phần thay đổi.
set -euo pipefail

APP_DIR=${APP_DIR:-/srv/kidsapp}
APP_USER=${APP_USER:-kidsapp}
REPO=${REPO:-https://github.com/vnkiddev/hygame.git}
BRANCH=${BRANCH:-main}
DOMAIN=${DOMAIN:-hygame.vnkid.dev}
ENV_FILE=/etc/kidsapp.env

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Cần chạy bằng sudo"

say "1/6 Gói hệ thống"
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-pip git ffmpeg >/dev/null

id -u "$APP_USER" >/dev/null 2>&1 || useradd -r -m -d "$APP_DIR" -s /bin/bash "$APP_USER"

say "2/6 Mã nguồn -> $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
	sudo -u "$APP_USER" git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
	sudo -u "$APP_USER" git -C "$APP_DIR" reset --hard --quiet "origin/$BRANCH"
else
	mkdir -p "$APP_DIR"
	chown "$APP_USER:$APP_USER" "$APP_DIR"
	sudo -u "$APP_USER" git clone --quiet --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
sudo -u "$APP_USER" mkdir -p "$APP_DIR"/{models,data,kids}

say "3/6 Môi trường Python"
[ -d "$APP_DIR/.venv" ] || sudo -u "$APP_USER" python3 -m venv "$APP_DIR/.venv"
sudo -u "$APP_USER" "$APP_DIR/.venv/bin/pip" install -q -U pip
sudo -u "$APP_USER" "$APP_DIR/.venv/bin/pip" install -q -r "$APP_DIR/backend/requirements.txt"

say "4/6 Cấu hình"
# Mở ra internet thì bắt buộc có mã quản trị. Chưa có thì tự sinh.
if [ ! -f "$ENV_FILE" ]; then
	TOKEN=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
	cat > "$ENV_FILE" <<ENVEOF
# Cấu hình máy chủ trò chơi. Sửa xong: systemctl restart kidsapp
ADMIN_TOKEN=$TOKEN
# Đứng sau proxy thì mọi request tới từ 127.0.0.1, lọc theo dải IP vô nghĩa.
# Cửa bảo vệ thật là ADMIN_TOKEN ở trên.
ALLOWED_NETS=*
ASR_THREADS=2
OMP_NUM_THREADS=2
ENVEOF
	chmod 640 "$ENV_FILE"
	chown root:"$APP_USER" "$ENV_FILE"
	say "   Đã sinh mã quản trị mới — GHI LẠI:  $TOKEN"
else
	say "   Giữ nguyên $ENV_FILE đang có"
fi

install -m644 "$APP_DIR/deploy/kidsapp.service" /etc/systemd/system/kidsapp.service
# Nạp file cấu hình vào unit nếu chưa có
grep -q EnvironmentFile /etc/systemd/system/kidsapp.service \
	|| sed -i "/^\[Service\]/a EnvironmentFile=$ENV_FILE" /etc/systemd/system/kidsapp.service

say "5/6 Khởi động dịch vụ"
systemctl daemon-reload
systemctl enable --quiet kidsapp
systemctl restart kidsapp

for i in $(seq 1 30); do
	sleep 2
	OUT=$(curl -fsS http://127.0.0.1:8000/api/health 2>/dev/null) && break || true
done
[ -n "${OUT:-}" ] || { journalctl -u kidsapp -n 30 --no-pager; die "Dịch vụ không lên"; }
echo "$OUT"
echo "$OUT" | grep -q '"warm": *true' \
	|| say "   ⚠️  warm=false — chưa có model ONNX trong $APP_DIR/models/ (app vẫn chạy, chỉ thiếu ASR máy chủ)"

say "6/6 Caddy ($DOMAIN)"
if command -v caddy >/dev/null; then
	install -m644 "$APP_DIR/deploy/Caddyfile.public" /etc/caddy/Caddyfile
	sed -i "s/hygame\.vnkid\.dev/$DOMAIN/" /etc/caddy/Caddyfile
	mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy 2>/dev/null || true
	systemctl reload caddy || systemctl restart caddy
	say "Xong. Mở https://$DOMAIN"
else
	say "Chưa có Caddy. Cài theo deploy/install.md mục 6, rồi chạy lại script này."
fi
