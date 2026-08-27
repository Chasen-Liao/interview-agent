import os

from agent.resources.question_bank import ALIASES, QUESTION_BANK

IGNORED_DIRS = {
    ".git",
    ".venv",
    "venv",
    "env",
    "node_modules",
    "dist",
    "build",
    "bundled-agent",
    "out",
    "target",
    "test",
    "tests",
    "__tests__",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
    ".sessions",
    ".idea",
    ".vscode",
    ".next",
    "coverage",
}


def _is_source_file(name: str) -> bool:
    """判断文件名是否是源码/文本文件（search_code 只搜这些）。

    跳过二进制文件（图片、pdf、可执行文件等），避免搜出乱码。
    """
    SOURCE_EXTENSIONS = (
        ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".go",
        ".c", ".cpp", ".h", ".hpp", ".rs", ".rb", ".php",
        ".txt", ".md", ".json", ".yaml", ".yml", ".toml",
        ".html", ".css", ".sql", ".sh", ".vue",
    )
    return name.lower().endswith(SOURCE_EXTENSIONS)


def _is_ignored_dir(name: str) -> bool:
    """判断目录是否应从项目读取工具中忽略。"""
    return name in IGNORED_DIRS or name.endswith(".egg-info")


class ListDirectoryTool:
    """列出项目目录结构。实现 Tool 接口（鸭子类型，无需继承）。"""

    def __init__(self, workspace: str) -> None:
        self.workspace = workspace

    @property
    def name(self) -> str:
        return "list_directory"

    @property
    def schema(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": "list_directory",
                "description": (
                    "列出项目里某个目录下的文件和子目录，用来了解项目结构。"
                    "根目录用 '.'。只看一层，不递归。"
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "相对工作区的目录路径，如 '.' 或 'src'",
                        }
                    },
                    "required": ["path"],
                },
            },
        }

    def execute(self, path: str) -> str:
        full_path = self._resolve(path)
        if not os.path.isdir(full_path):
            return f"错误：'{path}' 不是目录或不存在。"

        entries = []
        for name in sorted(os.listdir(full_path)):
            if _is_ignored_dir(name):
                continue
            entry_path = os.path.join(full_path, name)
            kind = "目录" if os.path.isdir(entry_path) else "文件"
            entries.append(f"{name} ({kind})")
        if not entries:
            return f"'{path}' 是空目录。"
        return "\n".join(entries)

    def _resolve(self, path: str) -> str:
        """路径校验：必须在工作区内，防止越权访问。"""
        full = os.path.realpath(os.path.join(self.workspace, path))
        workspace_real = os.path.realpath(self.workspace)
        if not full.startswith(workspace_real + os.sep) and full != workspace_real:
            raise ValueError(f"路径越界: {path}")
        return full


class SearchCodeTool:
    """按关键字搜索代码。"""

    def __init__(self, workspace: str) -> None:
        self.workspace = workspace

    @property
    def name(self) -> str:
        return "search_code"

    @property
    def schema(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": "search_code",
                "description": (
                    "在项目里搜索包含某关键字的代码，了解项目用了哪些技术/库/框架。"
                    "适合搜技术名（如 'flask'、'redis'、'threading'）来摸清技术栈，"
                    "不是用于核对某段具体实现写得好不好。"
                    "返回文件路径、行号和匹配的那一行。"
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "keyword": {
                            "type": "string",
                            "description": "要搜的关键字，如 'redis'、'Connection'",
                        }
                    },
                    "required": ["keyword"],
                },
            },
        }

    def execute(self, keyword: str) -> str:
        results: list[str] = []
        max_results = 20  # 第 3.6 节：最多 20 处，避免结果过长带偏 LLM

        for root, dirs, files in os.walk(self.workspace):
            dirs[:] = [name for name in dirs if not _is_ignored_dir(name)]
            for fname in files:
                if not _is_source_file(fname):
                    continue
                fpath = os.path.join(root, fname)
                rel_path = os.path.relpath(fpath, self.workspace)
                try:
                    with open(fpath, encoding="utf-8", errors="ignore") as f:
                        for line_no, line in enumerate(f, 1):
                            if keyword in line:
                                results.append(f"{rel_path}:{line_no}: {line.strip()}")
                                if len(results) >= max_results:
                                    break
                except OSError:
                    continue
                if len(results) >= max_results:
                    break

        if not results:
            return f"未找到包含 '{keyword}' 的代码。"
        if len(results) < max_results:
            header = f"找到 {len(results)} 处匹配："
        else:
            header = f"找到 {max_results} 处匹配（已截断）："
        return header + "\n" + "\n".join(results)


class LookupQuestionsTool:
    """按技术点读取内置追问题库。"""

    @property
    def name(self) -> str:
        return "lookup_questions"

    @property
    def schema(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": "lookup_questions",
                "description": (
                    "根据已在项目里确认使用的技术点，读取原理、权衡、实践三层追问。"
                    "只在 search_code 或项目描述确认技术真实存在后使用。"
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "tech": {
                            "type": "string",
                            "description": "技术关键字，如 redis、mysql、vue、jwt、并发",
                        }
                    },
                    "required": ["tech"],
                },
            },
        }

    def execute(self, tech: str) -> str:
        key = _normalize_tech(tech)
        questions = QUESTION_BANK.get(key)
        if not questions:
            topics = ", ".join(sorted(QUESTION_BANK))
            return f"未找到 '{tech}' 的内置题库。可用主题：{topics}"

        lines = [f"{key} 追问路径："]
        for layer, question in questions:
            lines.append(f"- {layer}：{question}")
        return "\n".join(lines)


def _normalize_tech(tech: str) -> str:
    """把用户或模型输入的技术名归一到题库 key。"""
    raw = tech.strip().lower()
    if raw in QUESTION_BANK:
        return raw
    if raw in ALIASES:
        return ALIASES[raw]
    for key in QUESTION_BANK:
        if key in raw:
            return key
    for alias, key in ALIASES.items():
        if alias in raw:
            return key
    return raw


class ReadFileTool:
    """读取文件内容。"""

    MAX_LINES = 200  # 第 3.6 节：超过 200 行截断

    def __init__(self, workspace: str) -> None:
        self.workspace = workspace

    @property
    def name(self) -> str:
        return "read_file"

    @property
    def schema(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": (
                    "读取项目里某个文件的内容，用于了解关键模块的大致实现思路。"
                    "不必逐行细究，重点是搞清楚这个模块用了什么技术、怎么组织的。"
                    "超大文件会被截断。"
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "相对工作区的文件路径，如 'src/db.py'",
                        }
                    },
                    "required": ["path"],
                },
            },
        }

    def execute(self, path: str) -> str:
        full_path = self._resolve(path)
        if not os.path.isfile(full_path):
            return f"错误：文件 '{path}' 不存在。"
        try:
            with open(full_path, encoding="utf-8", errors="ignore") as f:
                lines = f.readlines()
        except OSError as e:
            return f"读取失败: {e}"

        if len(lines) > self.MAX_LINES:
            truncated = "".join(lines[: self.MAX_LINES])
            note = (
                f"\n\n...(已截断，共 {len(lines)} 行，"
                f"只显示前 {self.MAX_LINES} 行)..."
            )
            return truncated + note
        return "".join(lines)

    def _resolve(self, path: str) -> str:
        """路径校验：必须在工作区内，防止越权访问。"""
        full = os.path.realpath(os.path.join(self.workspace, path))
        workspace_real = os.path.realpath(self.workspace)
        if not full.startswith(workspace_real + os.sep) and full != workspace_real:
            raise ValueError(f"路径越界: {path}")
        return full
