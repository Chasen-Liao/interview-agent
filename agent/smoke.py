"""进程级冒烟测试脚本（设计第 5E 节）。

用法（不通过 VS Code，直接喂数据给 Agent，零 API 费用）：
    python -u agent/smoke.py

验证设计第 5E.2 节：stdio 输出格式正确——
每行一条 JSON、stream 含回答、tool_call 有 start/end、done 结束。

为什么单独成脚本：main.py 走真实 stdio + 真实 LLM（要花钱）。
这个脚本用 FakeLLM 注入，复用 main 的完整闭环，但零费用、可重复跑。
它不是单测（单测在 tests/ 里），而是"手动冒烟"工具。
"""

import io
import json
import os
import sys
import tempfile

import agent.main as main_mod
from agent.llm_client import (
    FakeLLM,
    make_text_response,
    make_tool_call_response,
)
from agent.session import SessionStore


def run_smoke() -> int:
    """跑一次完整冒烟，返回发出的通知数。"""
    # 准备带 FakeLLM 的 store（模拟真实 LLM 的多轮：先调工具再回答）
    fake = FakeLLM([
        make_tool_call_response("list_directory", {"path": "."}),
        make_text_response(
            "我看到你的项目结构了。你这个项目最有挑战的部分是什么？"
            "用了什么技术栈？"
        ),
    ])

    tmp = tempfile.mkdtemp()
    store = SessionStore(llm_factory=lambda: fake)
    store._sessions_dir = os.path.join(tmp, ".sessions")
    store.configure(workspace=tmp, api_key="sk-smoke", model="gpt-4o-mini")

    # 喂 init + chat（模仿 VS Code 发的消息）
    inp = (
        json.dumps({"method": "init", "params": {
            "workspace": tmp, "api_key": "sk-smoke"}}) + "\n"
        + json.dumps({"method": "chat", "params": {
            "session": "smoke", "text": "我做了一个面试 Agent"}}) + "\n"
    )

    # 截获 stdout，逐行打印通知（真实 main 是写 sys.stdout）
    captured = []
    real_stdout = sys.stdout

    class CaptureStream:
        def write(self, s):
            captured.append(s)
            return len(s)

        def flush(self):
            pass

    sys.stdout = CaptureStream()
    try:
        main_mod.main(stream=io.StringIO(inp), store=store)
    finally:
        sys.stdout = real_stdout

    # 解析并打印每条通知
    print("=== 冒烟测试：Agent 内核 stdio 输出 ===")
    notifications = []
    for line in "".join(captured).splitlines():
        if not line.strip():
            continue
        notifications.append(json.loads(line))

    for n in notifications:
        method = n["method"]
        params = n["params"]
        if method == "tool_call":
            print(f"  tool_call | {params.get('tool')} | phase={params.get('phase')}")
        elif method == "stream":
            delta = params.get("delta", "")
            print(f"  stream    | {delta[:50]}{'...' if len(delta) > 50 else ''}")
        elif method == "done":
            print(f"  done      | session={params.get('session')}")
        elif method == "error":
            print(f"  error     | {params.get('message')}")

    print(f"=== 共 {len(notifications)} 条通知 ===")
    return len(notifications)


if __name__ == "__main__":
    run_smoke()
