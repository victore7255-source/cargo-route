#!/bin/bash
# 화물 혼적 경로 — 더블클릭으로 실행
# 로컬 서버를 켜고 브라우저를 자동으로 엽니다. (GPS 현재위치 기능은 이 방식에서만 동작)
cd "$(dirname "$0")"
PORT=8787
echo "🚚 화물 혼적 경로 서버를 시작합니다: http://localhost:$PORT"
echo "   종료하려면 이 창에서 Ctrl+C 를 누르거나 창을 닫으세요."
(sleep 1 && open "http://localhost:$PORT") &
python3 -m http.server $PORT
