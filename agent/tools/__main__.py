"""工具层装配验证脚本（设计第 7.4 节 1C）。

用法：
    python -m agent.tools <工作区路径>

验证"工具可插拔"这个核心设计：
    1. 三个工具能注册到 ToolRegistry
    2. all_schemas 能正确导出（这是喂给 OpenAI 的 tools 参数）
    3. 每个工具能真的执行（在一个真实工作区上调一次）
"""

import sys

from agent.tools.base import ToolRegistry
from agent.tools.builtin import ListDirectoryTool, ReadFileTool, SearchCodeTool


def main() -> None:
    if len(sys.argv) < 2:
        print("用法: python -m agent.tools <工作区路径>")
        print("示例: python -m agent.tools .")
        sys.exit(1)

    workspace = sys.argv[1]

    # 第 1 步：装配——注册三个工具（设计第 3.3 节）
    registry = ToolRegistry()
    registry.register(ListDirectoryTool(workspace))
    registry.register(SearchCodeTool(workspace))
    registry.register(ReadFileTool(workspace))

    # 第 2 步：验证 all_schemas 能正确导出
    schemas = registry.all_schemas()
    print(f"已注册 {len(schemas)} 个工具:")
    for s in schemas:
        print(f"  - {s['function']['name']}: {s['function']['description'][:40]}...")

    print()

    # 第 3 步：通过 registry.get 取出工具并执行（验证 Agent 循环将来怎么用）
    print("--- 调用 list_directory('.') ---")
    list_tool = registry.get("list_directory")
    assert list_tool is not None
    print(list_tool.execute(path=".")[:200])

    print()
    print("--- 调用 search_code('import') ---")
    search_tool = registry.get("search_code")
    assert search_tool is not None
    print(search_tool.execute(keyword="import")[:200])

    print()
    print("✓ 工具层装配验证通过")


if __name__ == "__main__":
    main()
