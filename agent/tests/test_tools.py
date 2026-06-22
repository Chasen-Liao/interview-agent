"""工具层测试（设计第 7.2.1 / 7.2.2 节）。

测试目标：覆盖三个内置工具的正常路径 + 边界情况 + 错误路径。
关键覆盖点：
- 路径越权被拒（安全设计）
- 超长文件被截断（结果精炼）
- search_code 限 20 处（结果精炼）
- 跳过非源码文件（避免搜出乱码）
- 文件/目录不存在时的优雅处理
"""

import pytest

from agent.tools.builtin import (
    ListDirectoryTool,
    ReadFileTool,
    SearchCodeTool,
    _is_source_file,
)

# ──────────────────────────────────────────────
# 辅助函数测试（纯函数，最好测）
# ──────────────────────────────────────────────


class TestIsSourceFile:
    """测试 _is_source_file 纯函数。"""

    def test_python_file_is_source(self):
        assert _is_source_file("app.py") is True

    def test_js_file_is_source(self):
        assert _is_source_file("app.js") is True

    def test_uppercase_extension(self):
        # 大写后缀也应该匹配
        assert _is_source_file("App.PY") is True

    def test_binary_file_not_source(self):
        assert _is_source_file("image.png") is False

    def test_executable_not_source(self):
        assert _is_source_file("program.exe") is False


# ──────────────────────────────────────────────
# ListDirectoryTool 测试
# ──────────────────────────────────────────────


class TestListDirectory:
    def test_lists_files_and_dirs(self, tmp_path):
        """能区分文件和目录。"""
        (tmp_path / "app.py").write_text("print('hi')")
        (tmp_path / "src").mkdir()
        (tmp_path / "data.txt").write_text("hello")

        tool = ListDirectoryTool(str(tmp_path))
        result = tool.execute(path=".")

        assert "app.py" in result
        assert "src" in result
        assert "目录" in result  # src 应标为目录
        assert "文件" in result  # app.py 应标为文件

    def test_empty_directory(self, tmp_path):
        """空目录有明确提示。"""
        tool = ListDirectoryTool(str(tmp_path))
        result = tool.execute(path=".")
        assert "空目录" in result

    def test_nonexistent_directory(self, tmp_path):
        """不存在的目录返回错误，不抛异常。"""
        tool = ListDirectoryTool(str(tmp_path))
        result = tool.execute(path="no_such_dir")
        assert "错误" in result

    def test_lists_only_one_level(self, tmp_path):
        """只看一层，不递归显示子目录内容。"""
        (tmp_path / "parent").mkdir()
        (tmp_path / "parent" / "child.py").write_text("x = 1")

        tool = ListDirectoryTool(str(tmp_path))
        result = tool.execute(path=".")

        assert "parent" in result
        assert "child.py" not in result  # 子目录的内容不应出现

    def test_rejects_path_escape(self, tmp_path):
        """路径越权必须被拒（安全设计第 3.4 节）。"""
        tool = ListDirectoryTool(str(tmp_path))
        with pytest.raises(ValueError, match="路径越界"):
            tool.execute(path="../../etc")


# ──────────────────────────────────────────────
# SearchCodeTool 测试
# ──────────────────────────────────────────────


class TestSearchCode:
    def test_finds_keyword(self, tmp_path):
        """能在源码文件里找到关键字。"""
        (tmp_path / "app.py").write_text("redis = Redis()\nprint('hello')\n")

        tool = SearchCodeTool(str(tmp_path))
        result = tool.execute(keyword="redis")

        assert "app.py" in result
        assert "1" in result  # 行号

    def test_returns_not_found_message(self, tmp_path):
        """没找到时返回明确提示，不抛异常。"""
        (tmp_path / "app.py").write_text("print('hi')\n")

        tool = SearchCodeTool(str(tmp_path))
        result = tool.execute(keyword="nonexistent_keyword")

        assert "未找到" in result

    def test_skips_non_source_files(self, tmp_path):
        """跳过二进制/非源码文件（避免搜出乱码）。"""
        (tmp_path / "app.py").write_text("keyword_here = 1\n")
        (tmp_path / "data.bin").write_text("keyword_here in binary")  # 不应被搜

        tool = SearchCodeTool(str(tmp_path))
        result = tool.execute(keyword="keyword_here")

        assert "app.py" in result
        assert "data.bin" not in result  # 非源码文件被跳过

    def test_limits_to_20_results(self, tmp_path):
        """超过 20 处匹配必须截断（结果精炼第 3.6 节）。"""
        # 造一个有 30 处匹配的文件
        content = "\n".join([f"match_line_{i}" for i in range(30)])
        (tmp_path / "big.py").write_text(content + "\n")

        tool = SearchCodeTool(str(tmp_path))
        result = tool.execute(keyword="match_line")

        # 统计匹配行数（每行一个匹配）
        match_count = result.count("big.py:")
        assert match_count == 20  # 必须被截断到 20
        assert "截断" in result   # 必须提示用户已截断

    def test_finds_across_multiple_files(self, tmp_path):
        """能跨多个文件搜索。"""
        (tmp_path / "a.py").write_text("target = 1\n")
        (tmp_path / "b.py").write_text("x = target\n")
        (tmp_path / "sub").mkdir()
        (tmp_path / "sub" / "c.py").write_text("y = target\n")

        tool = SearchCodeTool(str(tmp_path))
        result = tool.execute(keyword="target")

        assert "a.py" in result
        assert "b.py" in result
        assert "c.py" in result  # 子目录也搜到


# ──────────────────────────────────────────────
# ReadFileTool 测试
# ──────────────────────────────────────────────


class TestReadFile:
    def test_reads_file_content(self, tmp_path):
        """能读取文件内容。"""
        (tmp_path / "app.py").write_text("print('hello world')\n")

        tool = ReadFileTool(str(tmp_path))
        result = tool.execute(path="app.py")

        assert "hello world" in result

    def test_nonexistent_file_returns_error(self, tmp_path):
        """文件不存在返回错误字符串，不抛异常（让 Agent 自我恢复）。"""
        tool = ReadFileTool(str(tmp_path))
        result = tool.execute(path="ghost.py")

        assert "错误" in result
        assert "不存在" in result

    def test_truncates_long_file(self, tmp_path):
        """超过 200 行的文件必须截断（结果精炼第 3.6 节）。"""
        content = "\n".join([f"line {i}" for i in range(500)]) + "\n"
        (tmp_path / "big.py").write_text(content)

        tool = ReadFileTool(str(tmp_path))
        result = tool.execute(path="big.py")

        assert "已截断" in result
        assert "500" in result       # 提示总共多少行
        assert "line 199" in result  # 前 200 行保留
        assert "line 499" not in result  # 第 499 行被截掉

    def test_short_file_not_truncated(self, tmp_path):
        """短文件不应有截断提示。"""
        (tmp_path / "small.py").write_text("x = 1\ny = 2\n")

        tool = ReadFileTool(str(tmp_path))
        result = tool.execute(path="small.py")

        assert "已截断" not in result

    def test_rejects_path_escape(self, tmp_path):
        """路径越权必须被拒（安全设计）。"""
        tool = ReadFileTool(str(tmp_path))
        with pytest.raises(ValueError, match="路径越界"):
            tool.execute(path="../../../etc/passwd")

    def test_reads_from_subdirectory(self, tmp_path):
        """能读取子目录里的文件。"""
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "db.py").write_text("connection = None\n")

        tool = ReadFileTool(str(tmp_path))
        result = tool.execute(path="src/db.py")

        assert "connection" in result
