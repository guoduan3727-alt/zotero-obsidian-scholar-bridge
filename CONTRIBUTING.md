# Contributing

欢迎提交问题、改进建议和代码贡献。

## 本地验证

```powershell
npm ci
npm test
node --check chrome/content/scripts/core.js
node --check chrome/content/scripts/scholarBridge.js
npm run build
npm run validate
```

涉及 Zotero PDF 阅读器 UI 的修改还需要在真实 Zotero 中验收：工作台移动/缩放、词典预览滚动、PDF 选区、右键引用、公式显示和 Obsidian 写入。

请勿提交 API Key、真实 Vault 内容、论文 PDF、个人路径或 `.scholar-bridge` 用户数据。

提交前运行 `npm run security`。该检查也会在 GitHub Actions 中扫描源码和已构建 XPI，阻止常见密钥、私钥、个人路径、普通邮箱及 Vault 运行数据进入公开发布物。
