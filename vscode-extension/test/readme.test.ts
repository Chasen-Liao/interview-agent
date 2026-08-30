import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const rootReadme = readFileSync(join(__dirname, "..", "..", "README.md"), "utf-8");
const extensionReadme = readFileSync(join(__dirname, "..", "README.md"), "utf-8");

describe("README 发布说明", () => {
  it("根 README 包含安装、配置、隐私和故障排查关键说明", () => {
    for (const keyword of [
      "GitHub Release",
      "Demo Mode",
      "interview.apiKey",
      "interview.model",
      "导出报告",
      ".sessions",
      ".interview-agent/reports",
      "不会自动修改、提交或发布",
      "故障排查",
      "OCR",
      "图片简历",
    ]) {
      expect(rootReadme).toContain(keyword);
    }
  });

  it("扩展 README 保持简短但覆盖核心入口", () => {
    expect(extensionReadme).toContain("Demo Mode");
    expect(extensionReadme).toContain("测试模型连接");
    expect(extensionReadme).toContain("导出报告");
    expect(extensionReadme).toContain("图片简历");
    expect(extensionReadme).toContain("不会自动修改、提交或发布");
  });
});
