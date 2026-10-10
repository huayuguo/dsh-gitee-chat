# 安全策略

## 支持的版本

只对 npm 上 `latest` 的最新版本提供安全修复。

## 报告漏洞

**不要开公开 issue。** 请走 GitHub 私有漏洞报告：

<https://github.com/huayuguo/dsh-gitee-chat/security/advisories/new>

请附：影响版本、复现步骤、影响面（能否泄露 token / 越权写 Gitee）、建议修复方向。
收到后我会在 7 天内回复。

## 敏感数据提示

- Gitee 企业 access token 由使用者在本地配置（环境变量或 `$DSH_HOME/.gitee-chat/token`），
  本包不收集、不外发；日志与卡片不会回显完整 token。
- 网络出口只有：Gitee 企业 API、随包 MCP 后端的 Gitee 端点、以及仓库 WIKI 的 git 克隆。
