import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it, vi } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const JSZip = require("jszip");

vi.mock("vscode", () => ({
  commands: {},
  Uri: { joinPath: (...parts: Array<{ fsPath?: string } | string>) => parts.at(-1) },
  window: {},
}));

import { buildInstallCommand, parseResumeFile } from "../src/webviewPanel";

let tempRoot = "";

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  }
});

function tempFile(name: string, content: string): string {
  tempRoot = mkdtempSync(join(tmpdir(), "interview-agent-"));
  const path = join(tempRoot, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

async function tempDocx(name: string, content: string): Promise<string> {
  tempRoot = mkdtempSync(join(tmpdir(), "interview-agent-"));
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + "</Types>",
  );
  zip.folder("_rels")?.file(
    ".rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + "</Relationships>",
  );
  zip.folder("word")?.file(
    "document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + `<w:body><w:p><w:r><w:t>${content}</w:t></w:r></w:p></w:body></w:document>`,
  );
  const filePath = join(tempRoot, name);
  writeFileSync(filePath, await zip.generateAsync({ type: "nodebuffer" }));
  return filePath;
}

describe("parseResumeFile", () => {
  it("读取 txt 简历并返回文件名", async () => {
    const file = tempFile("resume.txt", "后端开发，熟悉 Redis");

    const result = await parseResumeFile(file);

    expect(result.fileName).toBe("resume.txt");
    expect(result.content).toContain("Redis");
    expect(result.truncated).toBe(false);
  });

  it("超长文本截断到 80000 字", async () => {
    const file = tempFile("resume.md", "a".repeat(80_010));

    const result = await parseResumeFile(file);

    expect(result.content).toHaveLength(80_000);
    expect(result.truncated).toBe(true);
  });

  it("空文本给出可读错误", async () => {
    const file = tempFile("empty.txt", "   \n");

    await expect(parseResumeFile(file)).rejects.toThrow("未从简历附件中提取到文字内容");
  });

  it("拒绝不支持的格式", async () => {
    const file = tempFile("resume.xlsx", "x");

    await expect(parseResumeFile(file)).rejects.toThrow(".pdf、.docx、.txt");
  });

  it("解析真实 docx 文本", async () => {
    const file = await tempDocx("resume.docx", "Resume Redis MySQL");

    const result = await parseResumeFile(file);

    expect(result.content).toContain("Resume Redis MySQL");
  });

  it("解析带文字层的 pdf 文本", async () => {
    const file = join(__dirname, "..", "node_modules", "pdf-parse", "test", "data", "01-valid.pdf");

    const result = await parseResumeFile(file);

    expect(result.content).toContain("Because traces are in SSA form");
  });

  it("PDF 文字层为空时触发 OCR fallback", async () => {
    const file = tempFile("resume.pdf", "%PDF-1.4\n");
    const statuses: string[] = [];

    const result = await parseResumeFile(file, {
      onStatus: (message) => statuses.push(message),
      ocr: async () => "OCR Redis MySQL",
      pdfText: async () => "",
    });

    expect(result.content).toBe("OCR Redis MySQL");
    expect(statuses).toContain("正在识别扫描版 PDF...");
  });

  it("生成 Windows Terminal 依赖安装命令", () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const command = buildInstallCommand("C:\\Python\\python.exe", "D:\\a b\\requirements-agent.txt");
      expect(command).toContain("& \"C:\\Python\\python.exe\" -m pip install -r");
      expect(command).toContain("\"D:\\a b\\requirements-agent.txt\"");
    } finally {
      if (original) {
        Object.defineProperty(process, "platform", original);
      }
    }
  });
});
