"""对话历史管理（设计第 6.2 节）。

三层防线的第 2、3 层：摘要 + 硬裁剪。
防止工具结果（整份代码）撑爆对话历史。
"""



# 第 3 层硬裁剪的 token 上限（设计第 6.2.3 节）
# 预留空间给系统提示 + 新回复，所以设得比模型上限小很多
MAX_HISTORY_TOKENS = 20000


def count_tokens(messages: list[dict]) -> int:
    """粗略估算 messages 的 token 数（设计第 6.2.3 节）。

    MVP 用"字符数 / 3"粗估（中文约 1 字 = 1 token，英文约 4 字符 = 1 token，
    折中取 3）。准确估算要装 tiktoken，MVP 阶段粗估够用。
    """
    total_chars = 0
    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, str):
            total_chars += len(content)
        # tool_calls 也算（function calling 的结构化调用）
        if "tool_calls" in msg:
            for tc in msg["tool_calls"]:
                total_chars += len(str(tc))
    return total_chars // 3


def compress_tool_result(msg: dict) -> dict:
    """把一个完整的工具结果压成摘要（设计第 6.2.2 节）。

    超过 200 字符的，保留头 100 字 + 省略提示 + 尾 50 字。
    让 LLM 知道"之前看过什么"，但不用带着完整内容。
    """
    content = msg.get("content", "")
    if len(content) <= 200:
        return msg
    summary = (
        content[:100]
        + f"\n...(已压缩，原 {len(content)} 字符)...\n"
        + content[-50:]
    )
    return {**msg, "content": summary}


def compress_history(
    messages: list[dict],
    max_tool_results_kept_full: int = 3,
) -> list[dict]:
    """第 2 层防线：老的 tool_result 压缩，保留最近 N 个完整。

    设计第 6.2.2 节：最近的 Observation 对当前决策最相关，
    老的细节 LLM 大概率用不上。
    """
    # 找出所有 tool 结果的位置（OpenAI 格式：role == "tool"）
    tool_indices = [
        i for i, m in enumerate(messages)
        if m.get("role") == "tool"
    ]

    # 要压缩的：超出"保留最近 N 个"之外的较早结果
    if len(tool_indices) <= max_tool_results_kept_full:
        return messages  # 没超过，不用压缩
    # 注意：不能用 [:-0]，因为 -0 == 0，list[:-0] 是空列表（Python 经典坑）
    if max_tool_results_kept_full == 0:
        to_compress = set(tool_indices)
    else:
        to_compress = set(tool_indices[:-max_tool_results_kept_full])

    return [
        compress_tool_result(m) if i in to_compress else m
        for i, m in enumerate(messages)
    ]


def enforce_token_limit(
    messages: list[dict],
    max_tokens: int = MAX_HISTORY_TOKENS,
) -> list[dict]:
    """第 3 层防线：超过 token 上限时硬裁剪（设计第 6.2.3 节）。

    关键纪律：永远保留 messages[0]（系统提示，Agent 灵魂）
    和 messages[-1]（最新用户消息，当前要回答的问题）。
    丢的是中间最老的。
    """
    result = list(messages)  # 不改原 list
    while count_tokens(result) > max_tokens and len(result) > 4:
        # 删掉 index 1（系统提示之后最早的）
        # 不能删 [0]（系统提示），不能删 [-1]（最新消息）
        result.pop(1)
    return result