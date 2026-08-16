#!/usr/bin/env bash
# Kéo code mới rồi khởi động lại — chạy định kỳ bởi hygame-autodeploy.timer.
#
# Có nó thì việc deploy không cần ai cả: hễ nhánh được push là vài phút sau
# máy chủ tự cập nhật. Cài một lần bằng deploy/install-autodeploy.sh.
set -euo pipefail

APP_DIR=${APP_DIR:-$HOME/apps/hygame}
BRANCH=${BRANCH:-claude/spec-video-rewards-5j3xrb}
PORT_FILE="$APP_DIR/.port"

cd "$APP_DIR"

git fetch --quiet origin "$BRANCH"
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")
[ "$LOCAL" = "$REMOTE" ] && exit 0     # không có gì mới, im lặng thoát

echo "$(date '+%F %T') cập nhật $(git rev-parse --short HEAD) -> $(git rev-parse --short origin/$BRANCH)"
git reset --hard --quiet "origin/$BRANCH"

# Phụ thuộc chỉ cài lại khi requirements đổi — tiết kiệm cho con i3
if ! git diff --quiet "$LOCAL" HEAD -- backend/requirements.txt; then
	echo "  requirements đổi, cài lại"
	.venv/bin/pip install -q -r backend/requirements.txt
fi

.venv/bin/python scripts/seed_kids.py >/dev/null 2>&1 || true

PORT=$(cat "$PORT_FILE" 2>/dev/null || echo 6003)
if command -v pm2 >/dev/null && pm2 describe hygame >/dev/null 2>&1; then
	pm2 restart hygame >/dev/null
	echo "  đã restart qua pm2"
else
	# Dừng theo tiến trình ĐANG NGHE trên cổng, không dò theo mẫu dòng lệnh
	HOLDERS=$(ss -tlnpH 2>/dev/null | grep ":$PORT " | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)
	OLDPID=$(cat "$APP_DIR/app.pid" 2>/dev/null || true)
	for pid in $HOLDERS $OLDPID; do kill "$pid" 2>/dev/null || true; done
	sleep 2
	nohup .venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port "$PORT" \
		< /dev/null > "$APP_DIR/app.log" 2>&1 &
	echo $! > "$APP_DIR/app.pid"
	echo "  đã restart qua nohup, cổng $PORT"
fi

for i in $(seq 1 20); do
	sleep 2
	if curl -fsS -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
		echo "  ✅ khoẻ lại sau $((i * 2))s"
		exit 0
	fi
done
echo "  ❌ không lên lại được — xem $APP_DIR/app.log"
exit 1
