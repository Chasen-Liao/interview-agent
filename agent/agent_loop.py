"""Agent 循环（设计第 2 节）。

项目心脏：让 LLM 能"多走几步"——每一步要么调工具，
要么直接回答。调工具就把结果塞回对话历史，让 LLM 再想下一步。
"""

from typing import Any, Callable

from agent.history import compress_history, enforce_token_limit
from agent.llm_client import LLMClient, LLMResponse
from agent.tools.base import ToolRegistry

# 回调类型：让外部（Phase 5 的协议层）能知道"循环在干什么"
# on_tool_call: 工具被调用时通知（UI 显示"正在搜代码"气泡）
# on_response: LLM 给出最终文本回答时通知（UI 流式输出）
ToolCallCallback = Callable[[str, dict[str, Any], str, str], None]
ResponseCallback = Callable[[str], None]


class AgentLoop:
    """Agent 循环（设计第 2 节）。

    核心逻辑：
        while 还没达到最大步数:
            调 LLM
            if LLM 想调工具:
                执行工具，结果塞回历史，继续循环
            else:
                输出回答，结束

    用法：
        loop = AgentLoop(llm=fake_llm, tools=registry)
        answer = loop.run("我做了一个选课系统")
    """

    def __init__(
        self,
        llm: LLMClient,
        tools: ToolRegistry,
        system_prompt: str,
        max_steps: int = 8,  # 设计第 2.5 节安全阀
    ) -> None:
        self._llm = llm
        self._tools = tools
        self._system_prompt = system_prompt
        self._max_steps = max_steps
        # 对话历史：整个 session 复用一份
        # 第一条永远是系统提示（设计第 6.2.3 节：永不删除）
        self._messages: list[dict] = [{"role": "system", "content": system_prompt}]

    @property
    def messages(self) -> list[dict]:
        """暴露历史（Phase 5 落盘用）。"""
        return self._messages
    

    def run(
        self,
        user_text: str,
        on_tool_call: ToolCallCallback | None = None,
        on_response: ResponseCallback | None = None,
    ) -> str:
        """跑一轮 Agent 循环。

        参数：
            user_text:    用户这一轮说的话
            on_tool_call: 工具调用回调（可选）
            on_response:  最终回答回调（可选）

        返回：Agent 的最终文本回答
        """
        # 把用户消息加入历史
        self._messages.append({"role": "user", "content": user_text})

        # 工具 schema：每次取一次（注册的工具可能变化）
        tools_schema = self._tools.all_schemas()

        for step in range(self._max_steps):
            # ── 每轮调 LLM 前：管理历史（设计第 6.2 节）──
            self._messages = compress_history(self._messages)
            self._messages = enforce_token_limit(self._messages)

            # ── 调 LLM ──
            response = self._llm.chat(self._messages, tools_schema)

            if response.tool_calls:
                # LLM 想调工具：处理所有工具调用，继续循环
                self._handle_tool_calls(response, on_tool_call)
                # 不 return，继续下一轮——LLM 拿到工具结果会再想下一步
            else:
                # LLM 直接回答了：输出文本，结束循环
                self._messages.append(
                    {"role": "assistant", "content": response.content}
                )
                if on_response:
                    on_response(response.content)
                return response.content

        # 循环跑满 max_steps 还没结束：触发安全阀
        fallback = "（已达到最大推理步数，本轮停止。你可以继续描述你的项目。）"
        self._messages.append({"role": "assistant", "content": fallback})
        if on_response:
            on_response(fallback)
        return fallback


    def _handle_tool_calls(
        self,
        response: LLMResponse,
        on_tool_call: ToolCallCallback | None,
    ) -> None:
        """处理 LLM 的所有工具调用，把结果塞回对话历史。

        设计第 3.9 节：工具失败不杀循环，错误当 Observation 喂回去。
        """
        # 先把 assistant 的工具调用意图加入历史（OpenAI 格式要求）
        self._messages.append({
            "role": "assistant",
            "content": response.content or "",
            "tool_calls": response.tool_calls,
        })

        # 逐个执行工具
        import json
        for tc in response.tool_calls:
            func = tc["function"]
            name = func["name"]
            # arguments 是 JSON 字符串（Phase 3 守护的格式）
            try:
                args = json.loads(func["arguments"])
            except json.JSONDecodeError:
                args = {}

            # 通知外部：工具开始
            if on_tool_call:
                on_tool_call(name, args, "start", "")

            # 执行工具（设计第 3.9 节：safe_execute 错误兜底）
            result = self._safe_execute(name, args)

            # 通知外部：工具结束
            if on_tool_call:
                on_tool_call(name, args, "end", result)

            # 把工具结果塞回历史（OpenAI 格式：role=="tool"，带 tool_call_id）
            self._messages.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": result,
            })

    def _safe_execute(self, name: str, args: dict[str, Any]) -> str:
        """安全执行工具（设计第 3.9 节）。

        工具失败不杀循环，把错误变成给 LLM 的文本，让它自我恢复。
        """
        tool = self._tools.get(name)
        if tool is None:
            # LLM 幻觉调用了不存在的工具
            return f"错误：不存在名为 '{name}' 的工具。可用工具：{[t for t in self._tools._tools]}"

        try:
            return tool.execute(**args)
        except Exception as e:
            # 错误当 Observation 喂回去，LLM 会自己调整策略
            return f"工具执行出错: {type(e).__name__}: {e}"
        
    