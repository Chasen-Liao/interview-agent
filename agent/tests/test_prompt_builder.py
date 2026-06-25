"""系统提示测试（设计第 7.2.1 节，第 1 层测试——纯逻辑）。

覆盖：
- 静态人设的关键内容在位（身份/工作流程/纪律/风格）
- 动态信息正确注入（项目路径、简历摘要）
- 简历为空时不注入空段落
- 返回格式是合法的 OpenAI system message

注意：不测 LLM 对提示的反应（那是 Phase 7 调提示的事），
只测"提示字符串拼得对不对"。
"""

from agent.prompt_builder import INTERVIEWER_SYSTEM_PROMPT, build_system_message

# ──────────────────────────────────────────────
# 静态人设：关键内容在位
# ──────────────────────────────────────────────


class TestStaticPrompt:
    def test_declares_interviewer_identity(self):
        """开头声明面试官身份（设计第 4.4.1 节）。"""
        assert "面试官" in INTERVIEWER_SYSTEM_PROMPT
        assert "面试" in INTERVIEWER_SYSTEM_PROMPT

    def test_mentions_target_student_level(self):
        """点明对象是"大三学生"（影响追问难度，设计第 4.4.1 节）。"""
        assert "大三" in INTERVIEWER_SYSTEM_PROMPT

    def test_defines_goal(self):
        """有明确的行为目标（设计第 4.4.2 节：定义成功标准）。"""
        assert "目标" in INTERVIEWER_SYSTEM_PROMPT

    def test_has_workflow_section(self):
        """有工作流程段（最核心，教 LLM 何时用 ReAct，设计第 4.4.3 节）。"""
        assert "工作流程" in INTERVIEWER_SYSTEM_PROMPT

    def test_teaches_when_to_use_tools(self):
        """教会 LLM 何时调工具（ReAct 触发条件）。"""
        assert "search_code" in INTERVIEWER_SYSTEM_PROMPT
        assert "read_file" in INTERVIEWER_SYSTEM_PROMPT

    def test_has_tool_discipline_section(self):
        """有调工具纪律段（防失控，设计第 4.4.4 节）。"""
        assert "纪律" in INTERVIEWER_SYSTEM_PROMPT

    def test_has_style_section(self):
        """有追问风格段（决定体验，设计第 4.4.5 节）。"""
        assert "风格" in INTERVIEWER_SYSTEM_PROMPT
        # "一次只问一个"是正面指令（设计第 4.5.2 节：正面优于负面）
        assert "一次只问一个" in INTERVIEWER_SYSTEM_PROMPT

    def test_prevents_role_drift(self):
        """有防角色漂移的指令（设计第 4.4.6 节）。"""
        assert "身份" in INTERVIEWER_SYSTEM_PROMPT

    def test_within_reasonable_length(self):
        """MVP 提示控制在合理长度（设计第 4.5.1 节：太长=太短）。
        上限放宽到 1500 字符，给完整的五件事留空间。"""
        assert len(INTERVIEWER_SYSTEM_PROMPT) < 1500


# ──────────────────────────────────────────────
# build_system_message：返回格式
# ──────────────────────────────────────────────


class TestBuildSystemMessageFormat:
    def test_returns_openai_system_message(self):
        """返回的是 OpenAI 格式的 system message。"""
        msg = build_system_message(workspace="/proj")

        assert msg["role"] == "system"
        assert isinstance(msg["content"], str)

    def test_includes_static_prompt(self):
        """内容包含完整的静态人设。"""
        msg = build_system_message(workspace="/proj")

        # 静态部分应该原样在内容里
        assert "面试官" in msg["content"]
        assert "工作流程" in msg["content"]


# ──────────────────────────────────────────────
# 动态信息注入（设计第 4.7 节）
# ──────────────────────────────────────────────


class TestDynamicInjection:
    def test_injects_workspace(self):
        """项目路径被正确注入。"""
        msg = build_system_message(workspace="H:\\project\\course-system")

        assert "H:\\project\\course-system" in msg["content"]

    def test_injects_workspace_with_hint(self):
        """注入路径时提示可用工具（教 LLM 怎么摸结构）。"""
        msg = build_system_message(workspace="/proj")

        assert "list_directory" in msg["content"]
        assert "search_code" in msg["content"]

    def test_injects_resume_when_provided(self):
        """提供简历时被注入。"""
        resume = "张三，大三，会 Python/MySQL，做过选课系统"
        msg = build_system_message(workspace="/proj", resume=resume)

        assert resume in msg["content"]
        assert "简历摘要" in msg["content"]

    def test_no_resume_section_when_absent(self):
        """没简历时不注入空段落（避免干扰 LLM）。"""
        msg = build_system_message(workspace="/proj")

        assert "简历摘要" not in msg["content"]

    def test_empty_resume_treated_as_absent(self):
        """空字符串简历等同没提供（不注入空段落）。"""
        msg = build_system_message(workspace="/proj", resume="")

        assert "简历摘要" not in msg["content"]

    def test_dynamic_info_appended_after_static(self):
        """动态信息在静态部分之后（人设在前，项目信息在后）。"""
        msg = build_system_message(workspace="/myproj", resume="简介")
        content = msg["content"]

        # 静态身份在前
        assert content.index("面试官") < content.index("/myproj")
        # 项目信息在简历前
        assert content.index("/myproj") < content.index("简介")

    def test_different_workspaces_produce_different_prompts(self):
        """不同项目路径产生不同提示（动态注入真的生效）。"""
        msg1 = build_system_message(workspace="/projA")
        msg2 = build_system_message(workspace="/projB")

        assert msg1["content"] != msg2["content"]
        assert "/projA" in msg1["content"]
        assert "/projB" in msg2["content"]
