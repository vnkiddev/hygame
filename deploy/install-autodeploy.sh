#!/usr/bin/env bash
# Cài dịch vụ tự cập nhật. Chạy MỘT LẦN trên máy chủ:
#
#     bash ~/apps/hygame/deploy/install-autodeploy.sh
#
# Sau đó không ai phải deploy tay nữa: cứ push lên nhánh là vài phút sau
# máy chủ tự kéo về, cài lại phụ thuộc nếu cần, restart và tự kiểm tra.
set -euo pipefail

APP_DIR=${APP_DIR:-$HOME/apps/hygame}
BRANCH=${BRANCH:-claude/spec-video-rewards-5j3xrb}
EVERY=${EVERY:-2min}
UNIT_DIR="$HOME/.config/systemd/user"

[ -d "$APP_DIR/.git" ] || { echo "Không thấy $APP_DIR — chạy deploy-lan.sh trước đã"; exit 1; }
mkdir -p "$UNIT_DIR"

cat > "$UNIT_DIR/hygame-autodeploy.service" <<UNIT
[Unit]
Description=Tu cap nhat hygame tu git
After=network-online.target

[Service]
Type=oneshot
Environment=APP_DIR=$APP_DIR
Environment=BRANCH=$BRANCH
ExecStart=$APP_DIR/deploy/autodeploy.sh
UNIT

cat > "$UNIT_DIR/hygame-autodeploy.timer" <<UNIT
[Unit]
Description=Kiem tra ban moi cua hygame moi $EVERY

[Timer]
OnBootSec=1min
OnUnitActiveSec=$EVERY
AccuracySec=30s

[Install]
WantedBy=timers.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now hygame-autodeploy.timer

# Dịch vụ người dùng phải sống cả khi chưa đăng nhập, nếu không thì tắt
# phiên ssh là timer chết theo.
if command -v loginctl >/dev/null; then
	loginctl enable-linger "$USER" 2>/dev/null \
		|| echo "1" | sudo -S loginctl enable-linger "$USER" 2>/dev/null || true
fi

echo
echo "✅ Xong. Từ giờ push lên nhánh $BRANCH là máy chủ tự cập nhật sau tối đa $EVERY."
echo
echo "   Xem lịch chạy:   systemctl --user list-timers hygame-autodeploy.timer"
echo "   Xem nhật ký:     journalctl --user -u hygame-autodeploy -n 30"
echo "   Cập nhật ngay:   systemctl --user start hygame-autodeploy.service"
echo "   Tắt đi:          systemctl --user disable --now hygame-autodeploy.timer"
