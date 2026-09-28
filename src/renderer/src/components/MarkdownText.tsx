// AI 回复的 Markdown 排版。只用于**已落盘**的消息——流式那半截、用户消息、就地编辑态照旧纯文本。
// 见 docs/tech.md §4「渲染层约定（Markdown 排版）」与 docs/design.md §4。
//
// 安全前提：react-markdown 产出的是 React 元素，全程不碰 innerHTML；内容里的原始 HTML
// （<script>、<img onerror=…>）没有上 rehype-raw，默认根本不解析，因此不需要消毒库。
// 链接做成 <span> 而不是 <a>、图片做成占位文字——不放宽 CSP，也不会打开任何外部地址。
import { memo, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useAppStore } from '../store/appStore'
import { CopyIcon } from './icons'

/** 代码块：灰底 + 等宽 + 语法高亮 + 右上角「复制」 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const toast = useAppStore((s) => s.toast)
  const ref = useRef<HTMLPreElement>(null)

  // 复制的是纯代码：语法高亮只是往文字上套 <span>，进不了 textContent
  const onCopy = async () => {
    try {
      await window.api.copyText(ref.current?.textContent ?? '')
      toast('已复制')
    } catch {
      toast('复制失败，请重试', 'error')
    }
  }

  return (
    <div className="md-pre">
      <button className="md-copy" title="复制这段代码" onClick={() => void onCopy()}>
        <CopyIcon size={13} />
        复制
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  )
}

/**
 * React.memo 是性能刚需，不是优化洁癖：流式期间聊天页每吐一个字就整体重渲染一次，
 * 不 memo 的话历史气泡会被反复重新解析 Markdown，长对话肉眼可见地卡。
 */
function MarkdownText({ content }: { content: string }) {
  // components 必须 useMemo：每次 render 新建这个对象会让上面那层 memo 完全失效
  const components = useMemo<Components>(
    () => ({
      // 链接只上色、不做成 <a>：点了没有任何反应（理由见 docs/requirements.md §3.4）
      a: ({ children }) => <span className="md-link">{children}</span>,
      // 图片不加载、不发任何网络请求，显示成占位文字
      img: ({ alt }) => <span className="md-img">[图片{alt ? `：${alt}` : ''}]</span>,
      // 代码块外面套一层，挂复制按钮
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
      // 表格外面套横向滚动容器，宽表格不撑破气泡
      table: ({ children }) => (
        <div className="md-table-wrap">
          <table>{children}</table>
        </div>
      )
    }),
    []
  )

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={components}
    >
      {content}
    </ReactMarkdown>
  )
}

export default memo(MarkdownText)
