import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const webviewRoot = join(__dirname, "..", "src", "webview");
const html = readFileSync(join(webviewRoot, "index.html"), "utf-8");
const script = readFileSync(join(webviewRoot, "main.js"), "utf-8");
const styles = readFileSync(join(webviewRoot, "styles.css"), "utf-8");

describe("Webview 面试入口模板", () => {
  it("输入区只有一个状态按钮，不再保留独立停止按钮", () => {
    expect(html).toContain('id="action"');
    expect(html).not.toContain('id="stop"');
    expect(script).toContain('vscode.postMessage({ type: "stop" })');
    expect(styles).toContain(".composer__action");
    expect(styles).toContain("right: 18px");
    expect(styles).toContain("bottom: 18px");
  });

  it("首屏包含简历上传和当前项目自动读取信息", () => {
    expect(html).toContain("上传简历附件");
    expect(html).toContain("支持 .pdf / .docx / .txt / .md");
    expect(html).toContain('class="resume-upload"');
    expect(html).toContain('id="resumeSupplement"');
    expect(html).toContain('id="workspaceInfo"');
    expect(html).not.toContain("简历 / 项目背景");
    expect(script).toContain('vscode.postMessage({ type: "pickResume" })');
    expect(script).toContain("请自动读取当前 VS Code 工作区下的项目情况");
  });

  it("处理 cancelled 通知并显示已停止状态", () => {
    expect(script).toContain('case "cancelled"');
    expect(script).toContain("onCancelled");
    expect(script).toContain("已停止");
  });
});
