import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const srcRoot = join(__dirname, "..", "src");
const extensionSource = readFileSync(join(srcRoot, "extension.ts"), "utf-8");
const panelSource = readFileSync(join(srcRoot, "webviewPanel.ts"), "utf-8");
const agentClientSource = readFileSync(join(srcRoot, "agentClient.ts"), "utf-8");

describe("面板加载性能回归", () => {
  it("extension 激活和配置快照阶段不做 Python openai 预检", () => {
    expect(extensionSource).not.toContain("locatePython");
    expect(extensionSource).not.toContain("requireOpenAI");
  });

  it("PDF/DOCX 重依赖只在上传简历时动态加载", () => {
    expect(panelSource).not.toMatch(/import\s+.*from\s+["']pdf-parse["']/);
    expect(panelSource).not.toMatch(/import\s+.*from\s+["']mammoth["']/);
    expect(panelSource).toContain('await import("pdf-parse/lib/pdf-parse.js")');
    expect(panelSource).toContain('await import("mammoth")');
  });

  it("真实模式启动时清理 Demo 环境变量，避免误走固定脚本", () => {
    expect(agentClientSource).toContain("delete env.INTERVIEW_FAKE_LLM");
  });
});
