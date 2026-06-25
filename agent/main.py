"""Agent 内核入口（设计第 1.4.3 节骨架 + 第 5D 节）。

这是 Python 子进程的 main——读 stdin 一行行 JSON-RPC，分发到 handler，
把 Agent 循环的结果通过 stdout 通知推回去。

设计第 1.4.3 节骨架：
    for line in sys.stdin:
        msg = json.loads(line)
        result = handle(msg)
        sys.stdout.write(json.dumps(result) + "\\n")
        sys.stdout.flush()

把"handle"拆成按 method 分发（init/chat/stop），三种 Request 各自的处理逻辑。
"""

import sys

import agent.protocol as protocol
from agent.session import SessionStore


def main(
    stream=None,
    store: SessionStore | None = None,
) -> None:
    """主循环：读 stdin，分发消息，输出通知。

    参数：
        stream: 输入流（默认 sys.stdin）。测试可传 io.StringIO。
        store:  会话仓库（默认新建）。测试可注入带 FakeLLM 的 store。

    退出条件：stdin 关闭（读到 EOF）即结束——VS Code 关闭时 stdin 会关。
    """
    if stream is None:
        stream = sys.stdin
    if store is None:
        store = SessionStore()

    handlers = {
        "init": lambda params: _handle_init(store, params),
        "chat": lambda params: _handle_chat(store, params),
        "stop": lambda params: _handle_stop(store, params),
    }

    for line in stream:
        msg = protocol.parse_message(line)
        if msg is None:
            # 格式错误：静默跳过（设计第 1.7 节容错，不杀进程）
            continue
        try:
            protocol.handle_message(msg, handlers)
        except Exception as e:
            # 业务层错误：发 error 通知，不杀进程（设计第 6.4.2 节）
            session = msg.get("params", {}).get("session", "unknown")
            protocol.notify_error(session, f"内部错误: {type(e).__name__}: {e}")


# ──────────────────────────────────────────────
# 三种 Request 的 handler
# ──────────────────────────────────────────────


def _handle_init(store: SessionStore, params: dict) -> None:
    """处理 init 消息：记录 workspace / api_key / model（设计第 1.5.2 节）。

    init 是会话开始时发一次的消息，给 Python 工作区路径和配置。
    """
    workspace = params.get("workspace")
    api_key = params.get("api_key")
    model = params.get("model", "gpt-4o-mini")
    base_url = params.get("base_url")
    resume = params.get("resume")

    if not workspace or not api_key:
        protocol.notify_error(
            params.get("session", "unknown"),
            "init 缺少必要参数（workspace 或 api_key）",
        )
        return

    store.configure(
        workspace=workspace,
        api_key=api_key,
        model=model,
        base_url=base_url,
        resume=resume,
    )


def _handle_chat(store: SessionStore, params: dict) -> None:
    """处理 chat 消息：跑一轮 Agent 循环（设计第 1.5.3 节时序）。

    chat 是最常用的消息——用户说的话。整个 Agent 循环在这里触发：
    1. 取（或新建）session 的 AgentLoop
    2. 跑 run()，回调把工具调用/回答转成通知
    3. 落盘历史（设计第 6.4.3 节）
    4. 发 done 通知
    """
    session = params.get("session", "default")
    text = params.get("text", "")

    # 拼上选中代码（设计第 5.3.3 节 attached_code）
    attached = params.get("attached_code")
    if attached and isinstance(attached, dict) and attached.get("content"):
        text = _inject_attached_code(text, attached)

    if not store.is_configured:
        protocol.notify_error(session, "未初始化：请先发送 init 消息")
        return

    loop = store.get_or_create(session)

    # 回调：把 Agent 循环的内部事件转成协议通知
    def on_tool_call(name, args, phase, result):
        protocol.notify_tool_call(
            session, name, phase,
            args=args if phase == "start" else None,
            result=result,
        )

    def on_response(content):
        # MVP 用非流式：整段回答一次性发出（Phase 7 加真实流式时分段）
        # 设计第 2.7 节：真正有文本的是最后一轮，这里整段发即可
        protocol.notify_stream(session, content)

    try:
        loop.run(text, on_tool_call=on_tool_call, on_response=on_response)
    except Exception as e:
        # LLM 调用失败等：发 error，不杀进程（设计第 6.4.1 节）
        protocol.notify_error(session, f"Agent 执行失败: {type(e).__name__}: {e}")
        return

    # 落盘历史（每轮对话后存一次，设计第 6.4.3 节）
    store.save(session)

    # 本轮结束
    protocol.notify_done(session)


def _handle_stop(store: SessionStore, params: dict) -> None:
    """处理 stop 消息：中断当前生成（设计第 1.5.2 节）。

    MVP 阶段 Agent 循环是同步的，stop 主要是个协议占位——
    真正的中断要在 Phase 6 接异步/线程时实现。
    收到 stop 至少不崩、不报错。
    """
    # MVP：no-op，协议兼容
    pass


def _inject_attached_code(text: str, attached: dict) -> str:
    """把选中的代码拼进用户消息（设计第 5.3.3 节）。

    格式：在用户原话前附上代码块，让面试官能针对这段代码追问。
    """
    file = attached.get("file", "未知文件")
    content = attached.get("content", "")
    return f"[选中代码 {file}]\n```\n{content}\n```\n\n我的问题：{text}"


if __name__ == "__main__":
    main()
