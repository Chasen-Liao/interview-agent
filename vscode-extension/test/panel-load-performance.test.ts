import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const srcRoot = join(__dirname, "..", "src");
const extensionSource = readFileSync(join(srcRoot, "extension.ts"), "utf-8");
const panelSource = readFileSync(join(srcRoot, "webviewPanel.ts"), "utf-8");

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
});
