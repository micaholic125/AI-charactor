# 参与贡献

感谢你愿意给 AI聊天卡 提代码或反馈。这个项目面向不懂技术的用户，交互尽量简单，改动请优先体验一致、文案清楚。

## 报告问题

- 用 [Bug 报告模板](.github/ISSUE_TEMPLATE/bug_report.yml) 开 issue，写清 Windows 版本、应用版本、复现步骤
- **不要粘贴 API Key**、完整聊天记录或 `%APPDATA%\ai-chat-cards\` 下的原始文件；需要贴日志时先删掉密钥
- 使用问题、功能想法也欢迎开 issue，但请先搜一下是否已有同类

## 开发环境

- Windows 10/11，Node.js ≥ 22.12
- `npm install` → `npm run dev` 启动开发模式（仓库根目录的 `启动AI聊天卡.bat` 是同一件事）

## 提交前自查

1. `npm run typecheck` 通过
2. `npm run build` 通过
3. 手动点一遍受影响的界面（项目没有自动化测试框架，界面改动以实际操作为准）
4. 临时调试代码（`console.log`、自检钩子、写死的测试数据）已删除

## 代码与文档约定

- **文档、日志、界面文案、注释一律中文**，代码标识符用英文
- 改功能前先改对应的标准文件：需求→`docs/requirements.md`，实现→`docs/tech.md`，界面→`docs/design.md`，阶段→`docs/execution.md`
- 保持小步提交，一次一个主题；提交信息用中文，说明「做了什么、为什么」
- 依赖版本是固定写死的（见 `docs/tech.md`），升级前先改文档并说明理由

## 绝对不要提交

- 任何 API Key、Token、密码
- `%APPDATA%\ai-chat-cards\` 里的真实用户数据（卡片、对话、记忆、头像）
- `node_modules/`、`out/`、`release/`、`测试区/`（已在 `.gitignore` 里）

## Pull Request

- 说明改了什么、为什么改、怎么验证的
- 涉及界面或行为的改动请附截图
- 新功能请同步更新 README 的「已知限制」与相关文档
