import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
);

describe("VS Code manifest", () => {
  it("把面试视图声明为 webview，否则 VS Code 会按 Tree View 查找数据提供程序", () => {
    const view = manifest.contributes.views["interview-agent"].find(
      (item: { id?: string }) => item.id === "interview.chatView",
    );

    expect(view).toBeTruthy();
    expect(view.type).toBe("webview");
  });

  it("view id 与激活事件保持一致", () => {
    expect(manifest.activationEvents).toContain("onView:interview.chatView");
  });
});
