import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 测试 TS 源码（非 out/ 编译产物），vitest 用 esbuild 直接跑 .ts
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
