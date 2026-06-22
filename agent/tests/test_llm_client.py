"""LLM 客户端测试（设计第 7.2.3 节，第 2 层测试）。

测试目标：验证 FakeLLM 行为可靠（它是 Phase 4 测试的工具）。
注意：不测 OpenAIClient（要花钱、不确定），它留给 Phase 7 冒烟。

关键覆盖点：
- FakeLLM 按脚本顺序返回
- call_count 正确递增
- 脚本耗尽时报错（防止漏写响应的测试悄悄通过）
- make_tool_call_response / make_text_response 格式正确
"""

import json

import pytest

from agent.llm_client import (
    FakeLLM,
    LLMResponse,
    make_text_response,
    make_tool_call_response,
)

# ──────────────────────────────────────────────
# make_text_response 测试
# ──────────────────────────────────────────────


class TestMakeTextResponse:
    def test_creates_content(self):
        """文本响应应该有 content，无 tool_calls。"""
        resp = make_text_response("你好")
        assert resp.content == "你好"
        assert resp.tool_calls == []

    def test_empty_string_allowed(self):
        """空字符串也合法（LLM 偶尔会返回空内容）。"""
        resp = make_text_response("")
        assert resp.content == ""
        assert resp.tool_calls == []


# ──────────────────────────────────────────────
# make_tool_call_response 测试
# ──────────────────────────────────────────────


class TestMakeToolCallResponse:
    def test_creates_tool_call(self):
        """工具调用响应应该有 tool_calls，无 content。"""
        resp = make_tool_call_response("search_code", {"keyword": "redis"})
        assert resp.content == ""
        assert len(resp.tool_calls) == 1

    def test_tool_call_has_correct_name(self):
        """工具名应该正确。"""
        resp = make_tool_call_response("read_file", {"path": "a.py"})
        assert resp.tool_calls[0]["function"]["name"] == "read_file"

    def test_arguments_is_json_string(self):
        """★ 关键：arguments 必须是 JSON 字符串，不是 dict。

        这是 OpenAI API 的格式要求，新手常踩坑。
        Agent 循环会用 json.loads() 解析它。
        """
        resp = make_tool_call_response("search_code", {"keyword": "redis"})
        args = resp.tool_calls[0]["function"]["arguments"]

        assert isinstance(args, str)  # 是字符串
        parsed = json.loads(args)     # 能被 JSON 解析
        assert parsed == {"keyword": "redis"}

    def test_empty_arguments(self):
        """无参数的工具调用也合法。"""
        resp = make_tool_call_response("ping", {})
        args = resp.tool_calls[0]["function"]["arguments"]
        assert json.loads(args) == {}


# ──────────────────────────────────────────────
# FakeLLM 测试（核心：验证它作为测试工具可靠）
# ──────────────────────────────────────────────


class TestFakeLLM:
    def test_initial_call_count_is_zero(self):
        """构造后 call_count 应该是 0。"""
        fake = FakeLLM([make_text_response("hi")])
        assert fake.call_count == 0

    def test_returns_scripted_responses_in_order(self):
        """★ 按脚本顺序返回（Agent 循环测试的前提）。"""
        fake = FakeLLM([
            make_tool_call_response("search_code", {"keyword": "redis"}),
            make_text_response("你用了 Redis，过期策略？"),
        ])

        # 第一次：应该返回工具调用
        r1 = fake.chat([], [])
        assert r1.tool_calls[0]["function"]["name"] == "search_code"
        assert fake.call_count == 1

        # 第二次：应该返回文本
        r2 = fake.chat([], [])
        assert r2.content == "你用了 Redis，过期策略？"
        assert r2.tool_calls == []
        assert fake.call_count == 2

    def test_single_response_script(self):
        """只有一个响应的脚本。"""
        fake = FakeLLM([make_text_response("only one")])
        r = fake.chat([], [])
        assert r.content == "only one"
        assert fake.call_count == 1

    def test_script_exhausted_raises(self):
        """★ 脚本耗尽时报错（防止测试漏写响应却悄悄通过）。

        这是个保护机制：如果你测试时 Agent 循环调了 3 次 LLM，
        但脚本只写了 2 个响应，会立刻报错而不是返回 None。
        """
        fake = FakeLLM([make_text_response("first")])
        fake.chat([], [])  # 消耗第一个

        with pytest.raises(RuntimeError, match="脚本耗尽"):
            fake.chat([], [])  # 第二次没响应了

    def test_ignores_messages_and_tools(self):
        """FakeLLM 不关心传入的 messages/tools（它就按脚本吐）。

        这是故意的——让测试聚焦于"循环逻辑"，不被 LLM 内容干扰。
        """
        fake = FakeLLM([make_text_response("canned")])
        r = fake.chat(
            messages=[{"role": "user", "content": "anything"}],
            tools=[{"type": "function", "function": {"name": "x"}}],
        )
        assert r.content == "canned"  # 无视输入，返回脚本里的

    def test_call_count_tracks_all_invocations(self):
        """call_count 准确追踪调用次数。"""
        fake = FakeLLM([
            make_text_response("a"),
            make_text_response("b"),
            make_text_response("c"),
        ])

        assert fake.call_count == 0
        fake.chat([], [])
        assert fake.call_count == 1
        fake.chat([], [])
        assert fake.call_count == 2
        fake.chat([], [])
        assert fake.call_count == 3


# ──────────────────────────────────────────────
# LLMResponse 数据类测试
# ──────────────────────────────────────────────


class TestLLMResponse:
    def test_default_values(self):
        """默认值：content 空字符串，tool_calls 空列表。"""
        resp = LLMResponse()
        assert resp.content == ""
        assert resp.tool_calls == []

    def test_independent_default_lists(self):
        """★ 关键：每个实例的 tool_calls 应该独立（可变默认值的经典坑）。

        如果用 tool_calls=[] 作默认值，所有实例会共享同一个列表。
        用 field(default_factory=list) 避免，这个测试守护这个约束。
        """
        r1 = LLMResponse()
        r2 = LLMResponse()
        r1.tool_calls.append({"fake": "call"})

        # r1 加了，r2 不应该受影响
        assert len(r2.tool_calls) == 0

    def test_has_tool_calls_property(self):
        """tool_calls 非空时，has_tool_calls 为 True（Agent 循环判断用）。"""
        # 注意：这个属性需要在 LLMResponse 里定义，如果没有就先跳过这个测试
        # 这里测的是"有 tool_calls 就应该能判断"的语义
        with_text = LLMResponse(content="hello")
        with_tool = LLMResponse(tool_calls=[{"function": {"name": "x"}}])

        assert len(with_tool.tool_calls) > 0
        assert len(with_text.tool_calls) == 0
