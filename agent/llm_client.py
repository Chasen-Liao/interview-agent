"""LLM 客户端层（设计第 7.2.3 节）。

定义统一的 LLMClient 协议，让 Agent 循环不关心是真实 API 还是 FakeLLM。
测试用 FakeLLM（零费用、确定），真实运行用 OpenAIClient。
"""

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class LLMResponse:
    """LLM 一次调用的结构化响应。

    content:     LLM 输出的文本（可能为空，当它选择调工具时）
    tool_calls:  LLM 要调的工具列表（可能为空，当它直接回答时）
    """
    content: str = ""
    tool_calls: list[dict] = field(default_factory=list)


class LLMClient(Protocol):
    """统一的 LLM 客户端接口（鸭子类型）。

    Agent 循环只认这个接口，不关心是 OpenAIClient 还是 FakeLLM。
    """

    def chat(
        self,
        messages: list[dict],
        tools: list[dict],
    ) -> LLMResponse:
        """调一次 LLM，返回结构化响应。"""
        ...


class FakeLLM:
    """假 LLM，按预设脚本返回响应（设计第 7.2.3 节）。

    用法：构造时传一个响应列表，每次 chat() 消耗一个。
    测试时能精确控制 LLM"说什么"，零费用、完全确定。

    示例：
        fake = FakeLLM([
            make_tool_call_response("search_code", {"keyword": "redis"}),
            make_text_response("你用了 Redis，过期策略是什么？"),
        ])
        # 第一次 chat() 返回调工具，第二次返回回答
    """

    def __init__(self, script: list[LLMResponse]) -> None:
        self._script = script
        self._index = 0
        self.call_count = 0  # 测试用：验证 Agent 循环调了几次

    def chat(self, messages: list[dict], tools: list[dict]) -> LLMResponse:
        self.call_count += 1
        if self._index >= len(self._script):
            raise RuntimeError(
                f"FakeLLM 脚本耗尽：第 {self.call_count} 次调用，"
                f"但脚本只有 {len(self._script)} 个响应"
            )
        response = self._script[self._index]
        self._index += 1
        return response
    

def make_tool_call_response(
    tool_name: str,
    arguments: dict[str, Any],
) -> LLMResponse:
    """构造一个"调用工具"的响应（供 FakeLLM 脚本用）。

    格式模仿 OpenAI API 返回的 tool_calls 结构。
    """
    import json
    return LLMResponse(
        tool_calls=[{
            "id": f"call_{tool_name}",
            "type": "function",
            "function": {
                "name": tool_name,
                "arguments": json.dumps(arguments),
            },
        }]
    )


def make_text_response(text: str) -> LLMResponse:
    """构造一个"直接回答文本"的响应（供 FakeLLM 脚本用）。"""
    return LLMResponse(content=text)



class OpenAIClient:
    """真实 OpenAI 兼容 API 客户端（设计第 7.2.3 节）。

    MVP 阶段用非流式（简单可靠）。Phase 7 联调时再加流式输出。
    支持 OpenAI 兼容的 API（DeepSeek、Moonshot 等都行）。
    """

    def __init__(
        self,
        api_key: str,
        model: str = "gpt-4o-mini",
        base_url: str | None = None,
    ) -> None:
        # 延迟导入：只在真实使用时才 import openai
        # 这样测试代码 import llm_client 时不会强依赖 openai 库
        from openai import OpenAI
        self._model = model
        self._client = OpenAI(api_key=api_key, base_url=base_url)

    def chat(self, messages: list[dict], tools: list[dict]) -> LLMResponse:
        kwargs: dict[str, Any] = {
            "model": self._model,
            "messages": messages,
        }
        if tools:  # 没工具时不传 tools 参数（有些模型会报错）
            kwargs["tools"] = tools

        response = self._client.chat.completions.create(**kwargs)
        message = response.choices[0].message

        # 提取文本和工具调用
        content = message.content or ""
        tool_calls = []
        if message.tool_calls:
            for tc in message.tool_calls:
                tool_calls.append({
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    },
                })

        return LLMResponse(content=content, tool_calls=tool_calls)