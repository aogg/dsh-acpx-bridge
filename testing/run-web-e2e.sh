#!/bin/zsh
# 在同一个 shell 里同时启动 mock LLM + dsh web，并做自检。
# 用法：./testing/run-web-e2e.sh
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh"
nvm use 24 >/dev/null 2>&1

ROOT=/Applications/code/www/my/github/dsh-acpx-bridge
export DSH_HOME="$ROOT/.dsh-home"
export MOCK_LLM_KEY=sk-mock-test
export WORKBUDDY_MODEL_KEY=123456ao1234
export ACPX_BIN="$ROOT/testing/mock-acpx"
export NO_PROXY=127.0.0.1,localhost
export no_proxy=127.0.0.1,localhost

echo "[setup] 启动 mock LLM :8899"
node "$ROOT/testing/mock-llm.mjs" > /tmp/mockllm.log 2>&1 &
MOCK_PID=$!

echo "[setup] 启动 dsh web :3080"
cd "$ROOT"
DSH_BIN="$(npm root -g)/@deepseek-ai/dsh/lib/bin.js"
echo "[setup] dsh bin: $DSH_BIN"
dsh web --host 127.0.0.1 --port 3080 --no-open > /tmp/dshweb.log 2>&1 &
DSH_PID=$!

# 等待就绪
for i in $(seq 1 30); do
  code=$(curl -s --noproxy '*' -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/ 2>/dev/null)
  if [ "$code" = "200" ] || [ "$code" = "404" ]; then
    echo "[ready] dsh web is up (HTTP $code) after ${i}s"
    break
  fi
  sleep 1
done

echo "=== dsh web log ==="
cat /tmp/dshweb.log 2>/dev/null | head -40
echo "=== mock llm log ==="
cat /tmp/mockllm.log 2>/dev/null | head -10
echo "=== health ==="
curl -s --noproxy '*' -m 3 -o /dev/null -w 'web 3080: %{http_code}\n' http://127.0.0.1:3080/ 2>&1
curl -s --noproxy '*' -m 3 -o /dev/null -w 'mock 8899: %{http_code}\n' http://127.0.0.1:8899/v1/models 2>&1

echo "[hold] 服务保持运行 (PIDs: mock=$MOCK_PID dsh=$DSH_PID)"
wait
