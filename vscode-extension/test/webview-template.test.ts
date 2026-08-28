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
    expect(styles).toContain("right: 20px");
    expect(styles).toContain("bottom: 20px");
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

  it("面试官消息渲染 Markdown，用户/工具消息保持纯文本", () => {
    expect(script).toContain("function renderMarkdown");
    expect(script).toContain("function escapeHtml");
    expect(script).toContain("function renderInline");
    // 面试官气泡走 Markdown 渲染（先转义再转换，无注入面）
    expect(script).toContain("body.innerHTML = renderMarkdown");
    // 行内代码防二次转换的占位机制
    expect(script).toContain("md-code");
    // 取消提示同样经 Markdown 渲染
    expect(script).toContain("body.__raw");
  });

  it("会话条目按钮不被挤压换行（窄侧边栏回归）", () => {
    expect(styles).toContain(".session-item__buttons");
    expect(styles).toContain("flex: 0 0 auto");
    expect(styles).toContain("white-space: nowrap");
    expect(styles).toContain(".session-item__buttons .secondary-button");
  });

  it("0.1.7 普通聊天发送不再保存配置重启 Agent", () => {
    expect(script).toContain("function send()");
    expect(script).toContain("sendChat(text, text);");
    expect(script).not.toContain("saveConfig(() => sendChat(text, text))");
  });

  it("模型配置移入 VS Code 设置，面板不再展示配置表单", () => {
    expect(html).toContain('id="settings"');
    expect(html).not.toContain('id="provider"');
    expect(html).not.toContain('id="model"');
    expect(html).not.toContain('id="baseUrl"');
    expect(html).not.toContain('id="apiKey"');
    expect(html).not.toContain('id="demoMode"');
    expect(html).not.toContain('id="saveConfig"');
    expect(script).not.toContain("function saveConfig");
    expect(script).not.toContain('type: "updateConfig"');
  });

  it("包含依赖安装和历史会话入口", () => {
    expect(html).toContain('id="dependencyPanel"');
    expect(html).toContain('id="installDependencies"');
    expect(html).toContain('id="historyPanel"');
    expect(html).toContain('id="newSession"');
    expect(script).toContain('type: "installDependencies"');
    expect(script).toContain('type: "resumeSession"');
    expect(script).toContain('type: "deleteSession"');
  });

  it("对话区滚动，输入框固定在面板最底部", () => {
    expect(html).toContain('id="chat"');
    expect(html).toContain('class="chat is-hidden"');
    // 纵向 flex 骨架：设置页/对话页各自占满剩余区域
    expect(styles).toContain("flex-direction: column");
    expect(styles).toContain(".setup");
    expect(styles).toContain(".chat");
    expect(styles).toContain(".messages");
    expect(styles).toContain(".composer");
    // 设置页和消息流占满剩余空间（可滚动），输入框不参与压缩（钉在底部）
    expect(styles).toContain("flex: 1 1 auto");
    expect(styles).toContain("flex: 0 0 auto");
    expect(styles).toContain("overflow-y: auto");
    expect(styles).toContain("min-height: 0");
    expect(styles).not.toContain("max-height: 38vh");
    expect(styles).toContain("min-height: 92px");
    expect(styles).toContain("width: 32px");
    expect(styles).toContain("height: 32px");
  });

  it("初始进入设置页，开始/继续会话进入对话页，新建会话回设置页", () => {
    expect(script).toContain('const chatEl = document.getElementById("chat")');
    expect(script).toContain("function showSetupPage");
    expect(script).toContain("function showChatPage");
    expect(script).toContain('chatEl.classList.add("is-hidden")');
    expect(script).toContain('chatEl.classList.remove("is-hidden")');
    expect(script).toContain("showChatPage();\n    sendChat(text");
    expect(script).toContain('if (msg.type === "sessionNew")');
    expect(script).toContain('showSetupPage("已新建会话")');
  });

  it("顶栏为品牌标识布局（logo + 标题 + 副标题）", () => {
    expect(html).toContain("topbar__brand");
    expect(html).toContain("topbar__logo");
    expect(html).toContain("topbar__title");
    expect(html).toContain("topbar__subtitle");
    expect(styles).toContain(".topbar__logo");
    expect(styles).toContain(".topbar__subtitle");
  });

  it("JD 与简历区为带步骤编号的卡片分区", () => {
    expect(html).toContain('class="card"');
    expect(html).toContain("card__step");
    expect(html).toContain("card__header");
    expect(html).toContain("card__hint");
    expect(html).toContain("岗位 JD");
    expect(html).toContain('id="jd"');
    expect(html).toContain('id="pickResume"');
    expect(html).toContain('id="resumeSupplement"');
    expect(styles).toContain(".card__step");
    expect(styles).toContain(".card");
  });

  it("依赖检测通过后隐藏依赖面板", () => {
    expect(script).toContain('dependencyPanelEl.classList.toggle("is-hidden", !status.message)');
  });
});
