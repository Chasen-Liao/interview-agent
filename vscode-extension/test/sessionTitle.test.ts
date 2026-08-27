import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  commands: {},
  Uri: { joinPath: (...parts: Array<{ fsPath?: string } | string>) => parts.at(-1) },
  window: {},
}));

import { makeSessionTitle } from "../src/webviewPanel";

describe("历史会话标题生成", () => {
  it("首条消息含岗位 JD 时，提取 JD 第一行作为标题", () => {
    const messages = [
      { role: "assistant", content: "你好" },
      {
        role: "user",
        content:
          "我们开始一场技术面试。\n\n岗位 JD：\n资深 Python 后端工程师，负责高并发系统\n\n当前项目：demo",
      },
    ] as Parameters<typeof makeSessionTitle>[0];

    const title = makeSessionTitle(messages, "fallback-id");
    expect(title).toBe("资深 Python 后端工程师，负责高并发系统");
  });

  it("JD 第一行超长时截断到 32 字", () => {
    const longJd = "岗".repeat(50);
    const messages = [
      {
        role: "user",
        content: `我们开始一场技术面试。\n\n岗位 JD：\n${longJd}`,
      },
    ] as Parameters<typeof makeSessionTitle>[0];

    expect(makeSessionTitle(messages, "id").length).toBe(32);
  });

  it("无 JD 标记时回退到首条用户消息的第一行", () => {
    const messages = [
      { role: "user", content: "聊聊我的 RAG 项目\n后面还有内容" },
    ] as Parameters<typeof makeSessionTitle>[0];

    expect(makeSessionTitle(messages, "id")).toBe("聊聊我的 RAG 项目");
  });

  it("没有用户消息时用会话 id 兜底", () => {
    const messages = [
      { role: "assistant", content: "你好" },
    ] as Parameters<typeof makeSessionTitle>[0];

    expect(makeSessionTitle(messages, "vscode-123")).toBe("vscode-123");
  });
});
