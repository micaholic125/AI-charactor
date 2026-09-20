// 开发日志自动化脚本（零依赖，Node 内置模块）
// 用法：
//   node scripts/devlog.mjs start   — 当日日志不存在则按模板创建（SessionStart 钩子调用）
//   node scripts/devlog.mjs end     — 向当日日志追加会话结束时间戳（SessionEnd 钩子调用）
// 路径基于脚本自身位置解析，与执行时的当前目录无关。

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const devlogDir = join(root, 'devlog')
const template = join(devlogDir, '_template.md')

const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`
const todayFile = join(devlogDir, `${dateStr}.md`)

const cmd = process.argv[2] || 'start'

mkdirSync(devlogDir, { recursive: true })

if (cmd === 'start') {
  if (!existsSync(todayFile)) {
    const content = existsSync(template)
      ? readFileSync(template, 'utf8').replace('# 开发日志', `# 开发日志 ${dateStr}`)
      : `# 开发日志 ${dateStr}\n\n## 今日完成\n- [ ] （无）\n\n## 待办事项\n- [ ] （无）\n\n## 备注\n`
    writeFileSync(todayFile, content)
    console.log(`[devlog] 已创建当日日志: ${todayFile}`)
  } else {
    console.log(`[devlog] 当日日志已存在: ${todayFile}`)
  }
} else if (cmd === 'end') {
  if (existsSync(todayFile)) {
    appendFileSync(todayFile, `\n- [记录] ${timeStr} 会话结束（自动记录）\n`)
    console.log(`[devlog] 已记录会话结束时间: ${timeStr}`)
  } else {
    console.log('[devlog] 当日日志不存在，跳过')
  }
} else {
  console.error(`未知命令: ${cmd}（可用: start | end）`)
  process.exit(1)
}
