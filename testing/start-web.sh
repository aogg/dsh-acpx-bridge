#!/bin/zsh
# 稳定启动 dsh web 并保持运行：等待最多 90 秒直到端口就绪，打印带 token 的 URL。
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

cd "$ROOT"

# 先启动 mock LLM（如果没在跑）
if ! curl -s --noproxy '*' -m 2 -o /dev/null http://127.0.0.1:8899/v1/models; then
  echo "[setup] 启动 mock LLM :8899"
  node "$ROOT/testing/mock-llm.mjs" > /tmp/mockllm.log 2>&1 &
fi

echo "[setup] 启动 dsh web :3080"
dsh web --host 127.0.0.1 --port 3080 --no-open > /tmp/dshweb-run.log 2>&1 &

echo "[wait] 等待 web 就绪（最多 90s）..."
for i in $(seq 1 90); do
  if grep -q 'dsh web: http' /tmp/dshweb-run.log 2>/dev/null; then
    echo "[ready] 用时 ${i}s"
    break
  fi
  sleep 1
done

echo "=== dsh web URL ==="
grep 'dsh web: http' /tmp/dshweb-run.log 2>/dev/null
echo "=== 日志尾部 ==="
tail -5 /tmp/dshweb-run.log 2>/dev/null

wait
