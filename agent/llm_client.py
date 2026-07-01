"""LLM 客户端层（设计第 7.2.3 节）。

定义统一的 LLMClient 协议，让 Agent 循环不关心是真实 API 还是 FakeLLM。
测试用 FakeLLM（零费用、确定），真实运行用 OpenAIClient。
"""

from dataclasses import dataclass, field
import time
from typing import Any, Protocol


def _strip_surrogates(text: str) -> str:
    """清除字符串里的孤立代理项。

    Windows 文件名/文件内容可能含 \\udcaa 等代理项字符，UTF-8 编不出，
    openai 库序列化请求时会抛 UnicodeEncodeError。
    用 surrogatepass 编成原始字节，再 ignore 解码丢弃。
    """
    try:
        return text.encode("utf-8", "surrogatepass").decode("utf-8", "ignore")
    except (UnicodeDecodeError, UnicodeEncodeError):
        return text


def _clean_surrogates(obj: Any) -> Any:
    """递归清理数据结构里所有字符串的孤立代理项。

    对 dict / list / tuple 递归深入，对 str 清理，其他类型原样返回。
    这样 messages + tools 里无论坏字符藏多深（嵌套的 function.arguments 字符串等）
    都能在发给 openai 前清干净。
    """
    if isinstance(obj, str):
        return _strip_surrogates(obj)
    if isinstance(obj, dict):
        return {k: _clean_surrogates(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clean_surrogates(item) for item in obj]
    if isinstance(obj, tuple):
        return tuple(_clean_surrogates(item) for item in obj)
    return obj


@dataclass
class LLMResponse:
    """LLM 一次调用的结构化响应。

    content:     LLM 输出的文本（可能为空，当它选择调工具时）
    tool_calls:  LLM 要调的工具列表（可能为空，当它直接回答时）
    """
    content: str = ""
    tool_calls: list[dict] = field(default_factory=list)


# ──────────────────────────────────────────────
# 错误分类（设计第 6.4.2 节）
# ──────────────────────────────────────────────

# 错误类型：决定给用户什么提示、是否重试
# rate_limit / auth = 用户可感知原因；connection / server = 临时故障可重试
ERROR_KIND_RATE_LIMIT = "rate_limit"      # 429：请求太频繁 / 余额不足
ERROR_KIND_AUTH = "auth"                  # 401：key 无效（不可恢复，重试无意义）
ERROR_KIND_CONNECTION = "connection"      # 断网 / 超时 / DNS（临时，可重试）
ERROR_KIND_SERVER = "server"              # 5xx：服务端临时故障（可重试）
ERROR_KIND_UNKNOWN = "unknown"


@dataclass
class LLMError(Exception):
    """LLM 调用失败的统一异常，携带错误类型和友好提示。

    把 openai 的各种异常归一成 kind + message，让上层（main.py）能据此
    给用户不同的提示（设计第 6.4.2 节），重试逻辑也能据此判断是否重试。
    """
    kind: str
    message: str

    def __post_init__(self) -> None:
        # dataclass + Exception：需要手动调 super().__init__ 让 message 成为异常信息
        super().__init__(self.message)


def _classify_openai_error(e: Exception) -> LLMError:
    """把 openai 异常映射成 LLMError（设计第 6.4.2 节）。

    区分可恢复（rate_limit/connection/server，可重试）和不可恢复（auth，让用户改 key）。
    """
    # 延迟导入 openai 异常类：测试环境可能用注入的 mock，不强依赖 openai 装载
    import openai as _openai

    # 顺序敏感：子类要在父类前判断（APITimeoutError 是 APIConnectionError 子类）
    if isinstance(e, _openai.AuthenticationError):
        return LLMError(
            ERROR_KIND_AUTH,
            "API key 无效或余额不足。请在设置里检查 interview.apiKey 和余额。",
        )
    if isinstance(e, _openai.RateLimitError):
        return LLMError(
            ERROR_KIND_RATE_LIMIT,
            "请求太频繁或余额不足。请稍等几秒再试，或检查账户额度。",
        )
    if isinstance(e, (_openai.APITimeoutError, _openai.APIConnectionError)):
        return LLMError(
            ERROR_KIND_CONNECTION,
            "网络连接失败或超时。请检查网络或 interview.baseUrl 配置。",
        )
    if isinstance(e, _openai.InternalServerError):
        return LLMError(
            ERROR_KIND_SERVER,
            "服务端临时故障（5xx）。请稍后重试。",
        )
    # 其他 openai 异常（APIError、APIStatusError 等）
    return LLMError(
        ERROR_KIND_UNKNOWN,
        f"调用失败: {type(e).__name__}: {e}",
    )


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
        # 终极防御：清掉所有数据里的孤立代理项。
        # Windows 文件名/文件内容可能含 \udcaa 等代理项，openai 序列化请求
        # body 时会抛 UnicodeEncodeError。在调用前递归清理整个数据结构。
        messages = _clean_surrogates(messages)
        tools = _clean_surrogates(tools)

        kwargs: dict[str, Any] = {
            "model": self._model,
            "messages": messages,
        }
        if tools:  # 没工具时不传 tools 参数（有些模型会报错）
            kwargs["tools"] = tools

        # 自动重试（设计第 6.4.2 节延伸）：仅对可恢复错误重试（429/断网/超时/5xx）。
        # 不可恢复错误（401 auth）不重试——重试也是 401，浪费。
        # 用 _call_with_retry 包住实际请求，把错误分类留给外层统一处理。
        response = self._call_with_retry(kwargs)

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

    def _call_with_retry(self, kwargs: dict[str, Any]):
        """带自动重试的 LLM 调用（设计第 6.4.2 节延伸）。

        策略：
        - 可恢复错误（rate_limit / connection / server）：重试，最多 3 次
        - 不可恢复错误（auth）：立刻抛 LLMError，不重试
        - 指数退避：1s → 2s → 4s
        - 重试用尽后仍失败：抛最后一次的 LLMError（已分类）

        返回原始 openai response 对象（chat 方法再解析）。
        """
        max_attempts = 3
        delay = 1.0

        last_error: LLMError | None = None
        for attempt in range(max_attempts):
            try:
                return self._client.chat.completions.create(**kwargs)
            except Exception as e:
                # 用延迟导入避免 openai 未安装时（纯 FakeLLM 测试）报错
                import openai as _openai
                # 非 openai 异常（如程序 bug）：不重试，直接抛
                if not isinstance(e, _openai.APIError):
                    raise

                last_error = _classify_openai_error(e)

                # 不可恢复错误（auth）：不重试
                if last_error.kind == ERROR_KIND_AUTH:
                    raise last_error

                # 可恢复错误：最后一次也直接抛（不再 sleep）
                if attempt == max_attempts - 1:
                    raise last_error

                # 中间次失败：指数退避后重试
                time.sleep(delay)
                delay *= 2

        # 理论上不会到这（上面 return 或 raise），保险起见
        assert last_error is not None
        raise last_error