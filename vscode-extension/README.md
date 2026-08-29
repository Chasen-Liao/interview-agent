# Interview Agent

会调工具的 AI 技术面试官。打开任意项目文件夹后，在 VS Code 侧边栏开始面试。

## 使用方式

1. 安装扩展并打开目标项目文件夹。
2. 在侧边栏打开 `Interview Agent`。
3. 开启 Demo Mode，或配置 `interview.apiKey`、`interview.baseUrl`、`interview.model`。
4. 点击“测试模型连接”确认配置可用。
5. 粘贴岗位 JD，上传简历或填写简历补充。
6. 开始面试，完成后可导出报告。

报告会以 Markdown 保存到当前工作区 `.interview-agent/reports`。历史会话保存在 `.sessions`。

本扩展只用于技术面试练习，不会自动修改、提交或发布你的代码。
