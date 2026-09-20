# AI 聊天卡

一个 Windows 桌面 AI 角色聊天应用。把「系统提示词（人设）+ 世界书（世界观）」保存成一张张**聊天卡**，点开即可与 AI 角色聊天。

- 🎴 聊天卡：人设、开场白、世界书、图片头像，支持导入/导出分享
- 💬 多对话：每张卡可开多个独立对话，流式打字机回复
- ⭐ 收藏 / 🕘 游玩历史：可置顶、可删除、可搜索
- 🌗 界面跟随系统浅色/深色，全部数据保存在本机

## 环境要求

- Windows 10/11
- Node.js **22.12 或更高版本**
  - 官网：https://nodejs.org （选 LTS 版本）
  - 国内镜像站：https://npmmirror.com/mirrors/node/ 或 https://nodejs.cn

## 快速开始

**第一次使用**（只需做一次，约几分钟）：

```bash
npm install     # 安装依赖（已配置国内镜像）
```

**以后每次启动应用**：双击项目根目录的 **`启动AI聊天卡.bat`**，等十几秒就会弹出应用窗口。

- 启动时会同时出现一个**黑色命令行窗口，它不能关**——关掉它应用会一起退出
- 退出应用：先关应用窗口，再关那个黑色窗口
- 想确认是不是卡住了：黑色窗口里有中文提示；启动失败时也会把原因写在那里，截图发给 AI 助手即可

> 熟悉命令行的话，等价于在项目目录执行 `npm run dev`。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发模式运行（改代码自动刷新） |
| `npm run typecheck` | 类型检查（代码质量校验） |
| `npm run build` | 编译项目（输出到 out/） |
| `npm run build:win` | 编译并打包成 Windows 安装包 + 便携版 |

打包产物在 `release\` 目录：
- `AI聊天卡-Setup-x.y.z.exe` — 安装包（自动建桌面快捷方式）
- `AI聊天卡-x.y.z-便携版.exe` — 便携版（免安装，适合发给朋友）

> 注意：应用未做数字签名，首次运行时 Windows SmartScreen 可能提示，点「更多信息 → 仍要运行」即可。

## 常见问题

**`npm run dev` 报错 `Electron uninstall`**
依赖安装时 Electron 二进制可能被 npm 安全策略拦截，手动补下载即可：

```bash
node node_modules/electron/install.js
```

**打包时 electron-builder 报错（阶段 6 打包前处理）**
某些包的安装脚本同样可能被拦截，运行 `npm install-scripts approve electron-winstaller` 后重新打包。

## 国内网络说明

项目根目录的 `.npmrc` 已配置国内镜像（npmmirror），安装依赖和打包时不会卡住。如果你不在国内或镜像异常，删除该文件即可恢复官方源。

## 数据存储位置

所有数据（卡片、对话、设置、头像）保存在：`%APPDATA%\ai-chat-cards\`

## 项目文档

- `docs/requirements.md` — 需求文档
- `docs/tech.md` — 技术方案
- `docs/design.md` — UI 设计规范
- `docs/execution.md` — 执行步骤与阶段标准
- `devlog/` — 每日开发日志（自动记录）

## 已知限制

- 超长对话会占用较多 token，可能触及模型上下文上限（可以删除对话重新开始）
- AI 回复以纯文本展示（暂不支持 Markdown 渲染）
- 中途停止生成的半截回复会保留为消息（有意设计）
