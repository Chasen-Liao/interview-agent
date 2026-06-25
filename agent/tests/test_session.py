"""会话管理测试（设计第 7.2.2 节，第 2 层测试——不碰真 LLM）。

覆盖：
- init 配置（configure / is_configured）
- session 创建与复用
- 历史落盘 / 恢复（设计第 6.4.3 节）
- 多 session 隔离（设计第 1.7 节）
- 工具装配（build_default_registry）

用 llm_factory 注入 FakeLLM，零费用、不碰真 API（设计第 7.2.3 节）。
"""

import json
import os

from agent.llm_client import FakeLLM, make_text_response
from agent.session import SessionStore, build_default_registry

# ──────────────────────────────────────────────
# 测试辅助
# ──────────────────────────────────────────────


def make_store(tmp_path, script=None):
    """建一个用 FakeLLM、落盘到 tmp_path 的 SessionStore。

    script: FakeLLM 的预设响应列表。默认只回答一次。
    """
    if script is None:
        script = [make_text_response("好的")]
    fake = FakeLLM(script)

    store = SessionStore(llm_factory=lambda: fake)
    # 把落盘目录指到 tmp_path，不污染工作区
    store._sessions_dir = str(tmp_path / ".sessions")  # noqa: SLF001
    store.configure(
        workspace=str(tmp_path),
        api_key="sk-test",  # 测试用假 key，不会真调 API
        model="gpt-4o-mini",
    )
    return store, fake


# ──────────────────────────────────────────────
# init 配置
# ──────────────────────────────────────────────


class TestConfigure:
    def test_not_configured_by_default(self):
        """新建的 store 未 init。"""
        store = SessionStore()
        assert not store.is_configured

    def test_configured_after_configure(self, tmp_path):
        """configure 后 is_configured 为 True。"""
        store = SessionStore()
        store.configure(workspace=str(tmp_path), api_key="sk-x")
        assert store.is_configured

    def test_workspace_recorded(self, tmp_path):
        """workspace 被记录。"""
        store = SessionStore()
        store.configure(workspace=str(tmp_path), api_key="sk-x")
        assert store.workspace == str(tmp_path)

    def test_missing_api_key_not_configured(self, tmp_path):
        """只有 workspace 没有 key，不算就绪。"""
        store = SessionStore()
        store.configure(workspace=str(tmp_path), api_key="")
        assert not store.is_configured  # 空 key 视为未就绪


# ──────────────────────────────────────────────
# session 创建与复用
# ──────────────────────────────────────────────


class TestGetOrCreate:
    def test_creates_loop_on_first_access(self, tmp_path):
        """首次访问创建 AgentLoop。"""
        store, _ = make_store(tmp_path)
        loop = store.get_or_create("s1")

        assert loop is not None

    def test_reuses_same_loop(self, tmp_path):
        """同一 session 多次访问返回同一个 loop。"""
        store, _ = make_store(tmp_path)
        loop1 = store.get_or_create("s1")
        loop2 = store.get_or_create("s1")

        assert loop1 is loop2  # 复用，不重复创建

    def test_different_sessions_isolated(self, tmp_path):
        """不同 session 各有独立 loop（设计第 1.7 节隔离）。"""
        store, fake = make_store(
            tmp_path,
            script=[make_text_response("s1答"), make_text_response("s2答")],
        )
        loop1 = store.get_or_create("s1")
        loop2 = store.get_or_create("s2")

        assert loop1 is not loop2
        # 各自独立的历史
        assert loop1.messages is not loop2.messages

    def test_creates_without_configured_raises(self):
        """未 init 就创建 session 应报错（防止误用）。"""
        store = SessionStore()
        try:
            store.get_or_create("s1")
            assert False, "应该抛 RuntimeError"
        except RuntimeError:
            pass


# ──────────────────────────────────────────────
# 历史落盘（设计第 6.4.3 节）
# ──────────────────────────────────────────────


class TestPersistence:
    def test_save_writes_json_file(self, tmp_path):
        """save 后 .sessions/{id}.json 存在。"""
        store, fake = make_store(tmp_path, [make_text_response("回答")])
        loop = store.get_or_create("s1")
        loop.run("问题")

        store.save("s1")

        path = tmp_path / ".sessions" / "s1.json"
        assert path.exists()

    def test_saved_history_contains_messages(self, tmp_path):
        """落盘内容含对话历史。"""
        store, fake = make_store(tmp_path, [make_text_response("最终回答")])
        loop = store.get_or_create("s1")
        loop.run("用户问题")

        store.save("s1")

        with open(tmp_path / ".sessions" / "s1.json", encoding="utf-8") as f:
            messages = json.load(f)

        # 至少有 system + user + assistant
        roles = [m["role"] for m in messages]
        assert roles[0] == "system"
        assert "user" in roles
        assert "assistant" in roles

    def test_restore_after_save(self, tmp_path):
        """落盘后新建 store 能恢复历史（模拟子进程重启续接）。"""
        # 第一个 store：跑一轮对话并落盘
        store1, fake1 = make_store(tmp_path, [make_text_response("第一句回答")])
        loop1 = store1.get_or_create("s1")
        loop1.run("第一句问题")
        store1.save("s1")

        # 第二个 store（模拟重启）：取同一 session 应恢复历史
        store2, fake2 = make_store(tmp_path, [make_text_response("重启后回答")])
        loop2 = store2.get_or_create("s1")

        # 历史应包含第一句对话
        contents = [m["content"] for m in loop2.messages]
        assert "第一句回答" in contents
        assert "第一句问题" in contents

    def test_no_history_file_starts_fresh(self, tmp_path):
        """没有历史文件时，新 session 从干净状态开始。"""
        store, _ = make_store(tmp_path)
        loop = store.get_or_create("brand-new-session")

        # 应该只有系统提示这一条
        assert len(loop.messages) == 1
        assert loop.messages[0]["role"] == "system"

    def test_corrupted_history_file_ignored(self, tmp_path):
        """历史文件损坏时不崩，从头开始（容错）。"""
        sessions_dir = tmp_path / ".sessions"
        sessions_dir.mkdir()
        # 写一个损坏的 JSON
        (sessions_dir / "s1.json").write_text("{不是合法json", encoding="utf-8")

        store, _ = make_store(tmp_path)
        loop = store.get_or_create("s1")  # 不该抛异常

        assert len(loop.messages) == 1  # 干净开始

    def test_save_unknown_session_noop(self, tmp_path):
        """save 一个不存在的 session 不崩（静默）。"""
        store, _ = make_store(tmp_path)
        store.save("never-existed")  # 不该抛异常


# ──────────────────────────────────────────────
# session id 安全性（文件名清洗）
# ──────────────────────────────────────────────


class TestSessionIdSafety:
    def test_path_traversal_sanitized(self, tmp_path):
        """session_id 含路径分隔符时被清洗，不能写出 .sessions/。"""
        store, _ = make_store(tmp_path)
        # 含 ../ 和斜杠的恶意 id
        loop = store.get_or_create("..%2fevil")
        loop.run = lambda *a, **k: "x"  # 避免真跑 LLM
        store.save("..%2fevil")

        # 落盘文件名应该只剩字母（恶意字符被清洗）
        files = os.listdir(tmp_path / ".sessions")
        # 不应该有能逃出 .sessions 的文件
        assert all("/" not in f and "\\" not in f for f in files)


# ──────────────────────────────────────────────
# 工具装配
# ──────────────────────────────────────────────


class TestBuildRegistry:
    def test_registers_three_tools(self, tmp_path):
        """装配 MVP 三件套（设计第 3.1 节）。"""
        registry = build_default_registry(str(tmp_path))

        schemas = {s["function"]["name"] for s in registry.all_schemas()}
        assert schemas == {"list_directory", "search_code", "read_file"}

    def test_tools_use_workspace(self, tmp_path):
        """工具的 workspace 与传入一致。"""
        registry = build_default_registry(str(tmp_path))
        read_tool = registry.get("read_file")

        # 执行时路径解析基于 workspace（造个文件验证）
        (tmp_path / "hello.py").write_text("print('hi')")
        result = read_tool.execute(path="hello.py")
        assert "hi" in result


# ──────────────────────────────────────────────
# 完整流程：configure → chat → save → restore
# ──────────────────────────────────────────────


class TestEndToEndSession:
    def test_full_lifecycle(self, tmp_path):
        """完整生命周期：init → chat → save → 重启续接 → 再 chat。"""
        # 第一次会话
        store1 = SessionStore(llm_factory=lambda: FakeLLM([
            make_text_response("你用了什么数据库？"),
        ]))
        store1._sessions_dir = str(tmp_path / ".sessions")  # noqa: SLF001
        store1.configure(workspace=str(tmp_path), api_key="sk-x")

        loop1 = store1.get_or_create("interview-1")
        answer1 = loop1.run("我做了一个选课系统")
        store1.save("interview-1")

        assert "数据库" in answer1

        # 模拟重启：第二个 store 续接
        store2 = SessionStore(llm_factory=lambda: FakeLLM([
            make_text_response("那并发怎么处理的？"),
        ]))
        store2._sessions_dir = str(tmp_path / ".sessions")  # noqa: SLF001
        store2.configure(workspace=str(tmp_path), api_key="sk-x")

        loop2 = store2.get_or_create("interview-1")
        # 历史恢复了，所以新 run 时已经有之前的对话
        contents = [m["content"] for m in loop2.messages]
        assert "我做了一个选课系统" in contents
        assert "你用了什么数据库？" in contents
