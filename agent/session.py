"""会话管理（设计第 6.4.3 节 + 第 1.8.3 节）。

职责：
1. 管理多个面试 session，每个 session 一份独立的 AgentLoop（含独立历史）
2. 每轮对话更新时把历史落盘（.sessions/{id}.json），子进程崩溃重启能续接
3. 持有 workspace 路径，工具以此为根目录

设计第 6.4.3 节：MVP 用 JSON 文件落盘，不上数据库（YAGNI）。
落盘目录 .sessions/ 已在 .gitignore（含代码内容，不能进版本库）。
"""

import json
import os
from typing import Any, Callable

from agent.agent_loop import AgentLoop
from agent.llm_client import LLMClient
from agent.prompt_builder import build_system_message
from agent.tools.base import ToolRegistry


def _strip_surrogates(text: str) -> str:
    """清除 UTF-8 无法编码的孤立代理项字符。"""
    try:
        return text.encode("utf-8", "surrogatepass").decode("utf-8", "ignore")
    except (UnicodeDecodeError, UnicodeEncodeError):
        return text


def _clean_for_json(obj: Any) -> Any:
    """递归清理要写入 JSON 的数据，避免落盘时编码失败。"""
    if isinstance(obj, str):
        return _strip_surrogates(obj)
    if isinstance(obj, dict):
        return {_clean_for_json(k): _clean_for_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clean_for_json(item) for item in obj]
    if isinstance(obj, tuple):
        return tuple(_clean_for_json(item) for item in obj)
    return obj


class SessionStore:
    """会话仓库：管 workspace + 多个 AgentLoop + 历史落盘。

    生命周期：
    - init 消息进来 → 记住 workspace / api_key / model，创建工具注册表
    - chat 消息进来 → 取（或新建）对应 session 的 AgentLoop → run → 落盘
    - 子进程重启 → 从 .sessions/ 恢复历史
    """

    def __init__(self, llm_factory: Callable[[], LLMClient] | None = None) -> None:
        # init 消息带来的全局配置（设计第 1.5.2 节）
        self._workspace: str | None = None
        self._api_key: str | None = None
        self._model: str = "gpt-4o-mini"
        self._base_url: str | None = None
        self._resume: str | None = None

        # 每个 session 一个 AgentLoop（含独立历史）
        self._loops: dict[str, AgentLoop] = {}

        # 历史落盘目录（设计第 6.4.3 节）
        self._sessions_dir = os.path.join(os.getcwd(), ".sessions")

        # LLM 工厂：生产时建 OpenAIClient，测试可注入返回 FakeLLM 的工厂
        # 不传则默认用真实 OpenAI（设计第 7.2.3 节：测试不碰真 API）
        self._llm_factory = llm_factory

    # ──────────────────────────────────────────────
    # init 配置
    # ──────────────────────────────────────────────

    def configure(
        self,
        workspace: str,
        api_key: str,
        model: str = "gpt-4o-mini",
        base_url: str | None = None,
        resume: str | None = None,
    ) -> None:
        """记录 init 消息带来的全局配置。

        这些配置在所有 session 间共享（同一进程管一个 workspace）。
        """
        self._workspace = workspace
        self._api_key = api_key
        self._model = model
        self._base_url = base_url
        self._resume = resume

    @property
    def workspace(self) -> str | None:
        return self._workspace

    @property
    def is_configured(self) -> bool:
        """是否已 init（workspace 和 api_key 都就绪）。

        空 key 也算未就绪——没 key 真实 LLM 调用必然失败。
        """
        return bool(self._workspace) and bool(self._api_key)

    # ──────────────────────────────────────────────
    # session 获取 / 创建（含历史恢复）
    # ──────────────────────────────────────────────

    def get_or_create(self, session_id: str) -> AgentLoop:
        """取一个 session 的 AgentLoop，没有就新建。

        新建时：优先从 .sessions/{id}.json 恢复历史（设计第 6.4.3 节）。
        """
        if session_id in self._loops:
            return self._loops[session_id]

        loop = self._create_loop(session_id)
        self._loops[session_id] = loop
        return loop

    def _create_loop(self, session_id: str) -> AgentLoop:
        """新建一个 AgentLoop，装配工具 + 系统提示 + 恢复历史。"""
        if not self.is_configured:
            raise RuntimeError("SessionStore 未 init：先调用 configure()")

        # 装配工具注册表（设计第 1.8.3 节：工具以 workspace 为根）
        tools = build_default_registry(self._workspace)  # type: ignore[arg-type]

        # 组装系统提示（设计第 4.7 节：注入 workspace 和 resume）
        system_msg = build_system_message(self._workspace, self._resume)  # type: ignore[arg-type]

        # 建真实 LLM 客户端（init 带来的 key/model）
        llm = self._build_llm()

        loop = AgentLoop(
            llm=llm,
            tools=tools,
            system_prompt=system_msg["content"],
        )

        # 尝试从盘恢复历史（设计第 6.4.3 节）
        self._restore(loop, session_id)

        return loop

    def _build_llm(self) -> LLMClient:
        """根据 init 配置建 LLM 客户端。

        测试时可通过构造函数注入 llm_factory 返回 FakeLLM（设计第 7.2.3 节）。
        默认建真实 OpenAIClient，延迟导入避免测试强依赖 openai 库。
        """
        if self._llm_factory is not None:
            return self._llm_factory()

        # 演示模式（设计第 5E 节冒烟用）：环境变量 INTERVIEW_FAKE_LLM=1 时
        # 用 FakeLLM 代替真实 API，零费用跑完整闭环，展示面试官对话效果。
        # 不用真 key、不花钱，用于本地演示和验证 UI。
        import os
        if os.environ.get("INTERVIEW_FAKE_LLM") == "1":
            return self._build_demo_llm()

        from agent.llm_client import OpenAIClient
        return OpenAIClient(
            api_key=self._api_key,  # type: ignore[arg-type]
            model=self._model,
            base_url=self._base_url,
        )

    def _build_demo_llm(self) -> LLMClient:
        """构造演示用的 LLM（零费用，模拟真实面试官多轮对话）。

        FakeLLM 脚本是线性消耗、耗尽即报错的，不适合多轮对话场景
        （用户可能连续发多条消息）。这里用一个专用的 DemoLLM：
        第一轮完整演示"调工具→追问"的链路，之后每轮直接追问，
        永不耗尽，让用户能持续体验面试官对话效果。
        """
        from agent.llm_client import (
            LLMResponse,
            make_text_response,
            make_tool_call_response,
        )

        return _DemoLLM([
            # 第 1 轮的完整链路：摸结构 → 读文件 → 追问
            make_tool_call_response("list_directory", {"path": "."}),
            make_tool_call_response("read_file", {"path": "README.md"}),
            make_text_response(
                "我看了一下你的项目结构和 README。这是一个会调工具的 AI 面试官项目，"
                "架构上 VS Code 插件 spawn Python 子进程通过 stdio 通信。\n\n"
                "我有几个追问：\n"
                "1. 你这个 Agent 循环最多跑多少步？如果 LLM 一直调工具不收敛，怎么兜底？\n"
                "2. 工具执行失败时，你是直接报错，还是把错误喂回给 LLM 让它自己恢复？\n"
                "3. 你怎么测试这个 Agent 的行为？用的真实 API 还是 mock？"
            ),
        ], fallback=[
            # 后续每轮：直接给不同的追问（循环复用，永不耗尽）
            make_text_response(
                "（演示模式：以下是预设的追问）\n\n"
                "你刚才提到的这部分，能展开讲讲具体实现吗？"
                "比如核心的数据结构或流程是怎么设计的？"
            ),
            make_text_response(
                "（演示模式）\n\n"
                "听起来不错。如果让你现在重新做，有哪些地方你会改进？\n"
                "当时踩过什么坑？"
            ),
        ])

    # ──────────────────────────────────────────────
    # 历史落盘 / 恢复（设计第 6.4.3 节）
    # ──────────────────────────────────────────────

    def save(self, session_id: str) -> None:
        """把 session 的历史落盘。

        每轮对话后调用一次——子进程崩溃重启后能从上次中断处续接。
        """
        loop = self._loops.get(session_id)
        if loop is None:
            return  # 没有 loop，没东西可存

        os.makedirs(self._sessions_dir, exist_ok=True)
        path = self._session_path(session_id)
        messages = _clean_for_json(loop.messages)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(messages, f, ensure_ascii=False, indent=2)

    def _restore(self, loop: AgentLoop, session_id: str) -> None:
        """从盘恢复历史到 loop（文件不存在则跳过）。"""
        path = self._session_path(session_id)
        if not os.path.isfile(path):
            return  # 没有历史文件，全新 session

        try:
            with open(path, encoding="utf-8") as f:
                messages = json.load(f)
        except (json.JSONDecodeError, OSError):
            return  # 历史文件损坏：忽略，从头开始（不崩）

        # 仅当读到的历史非空，且第一条仍是 system 时才覆盖
        # （防止历史里的 system 与当前 system_prompt 不一致导致混乱）
        if messages and messages[0].get("role") == "system":
            loop._messages = messages  # noqa: SLF001 — 续接历史需要直接换掉

    def _session_path(self, session_id: str) -> str:
        """一个 session 一个 JSON 文件。"""
        # session_id 当文件名，简单清洗防止路径穿越（不依赖 session_id 可信）
        safe = "".join(c for c in session_id if c.isalnum() or c in "-_")
        return os.path.join(self._sessions_dir, f"{safe}.json")

    def has_session(self, session_id: str) -> bool:
        """某个 session 是否已存在（内存或盘上）。"""
        return session_id in self._loops or os.path.isfile(self._session_path(session_id))

    def reset(self) -> None:
        """清空所有 session（主要给测试用，deactivate 时也可调）。"""
        self._loops.clear()


# ──────────────────────────────────────────────
# 工具装配（设计第 3 节三件套）
# ──────────────────────────────────────────────


def build_default_registry(workspace: str) -> ToolRegistry:
    """装配 MVP 三件套工具（设计第 3.1 节）。

    list_directory / search_code / read_file，都以 workspace 为根。
    Agent 循环靠这个 registry 执行工具。
    """
    from agent.tools.builtin import ListDirectoryTool, ReadFileTool, SearchCodeTool

    registry = ToolRegistry()
    registry.register(ListDirectoryTool(workspace))
    registry.register(SearchCodeTool(workspace))
    registry.register(ReadFileTool(workspace))
    return registry


# ──────────────────────────────────────────────
# 演示模式专用 LLM（设计第 5E 节冒烟）
# ──────────────────────────────────────────────


class _DemoLLM:
    """演示模式 LLM：首轮按脚本，之后循环复用 fallback，永不耗尽。

    FakeLLM 脚本线性消耗、耗尽报错，适合单测但不适合多轮 UI 演示。
    本类专为 demoMode 设计：
    - initial 脚本：第一轮对话按顺序消耗（演示完整的"调工具→追问"链路）
    - initial 耗尽后，用 fallback 循环复用（让用户能持续发消息）
    """

    def __init__(
        self,
        initial: list,
        fallback: list,
    ) -> None:
        from agent.llm_client import LLMResponse  # noqa: F401 — 类型提示用
        self._initial = initial
        self._fallback = fallback
        self._call_count = 0

    def chat(self, messages, tools):
        # 脚本未耗尽：按顺序返回
        if self._call_count < len(self._initial):
            resp = self._initial[self._call_count]
            self._call_count += 1
            return resp
        # 脚本耗尽：循环复用 fallback（永不报错）
        idx = (self._call_count - len(self._initial)) % len(self._fallback)
        self._call_count += 1
        return self._fallback[idx]
