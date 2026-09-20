// 聊天页状态条：显示当前生效的「供应商 · 模型 · 输出方式」，点击就地切换。
// 供应商起过名称就显示名称，没起名显示接口地址。浮层里按供应商分组列出各家的模型
// ——点一个模型即「这家 + 这个模型」一起用上（供应商是全局的，模型只写进这张卡）；
// 再点一下已经打勾的那个就是取消本卡指定，回到跟着供应商的默认模型走。
// 每组**只列这家挑过的「常用模型」**（一个都没挑过则照旧列全部），
// 但当前生效的那一行永远补在最前面。规范见 docs/design.md §4。
import { useEffect, useState } from 'react'
import type { Card, Provider } from '@shared/types'
import { DEFAULT_PROVIDER_MODEL, DEFAULT_SETTINGS, providerLabel } from '@shared/types'
import { useAppStore } from '../store/appStore'
import { CheckIcon, ChevronDownIcon } from './icons'

interface Props {
  card: Card
  /** 改动交给 ChatPage 落盘并刷新缓存 */
  onPatch: (patch: Partial<Card>) => void
}

/** 状态条上省掉协议前缀，太长；接口地址本身还是完整展示在浮层里 */
function shortUrl(baseUrl: string): string {
  return (baseUrl ?? '').replace(/^https?:\/\//, '')
}

/** 状态条上的供应商写法：起过名称就用名称，没起名用去掉协议前缀的地址 */
function barLabel(p: Provider): string {
  const name = (p.name ?? '').trim()
  return name !== '' ? name : shortUrl(p.baseUrl)
}

export default function ChatSettingsBar({ card, onPatch }: Props) {
  const toast = useAppStore((s) => s.toast)
  const navigate = useAppStore((s) => s.navigate)

  const [open, setOpen] = useState(false)
  const [providers, setProviders] = useState<Provider[]>([])
  const [currentId, setCurrentId] = useState('')
  // 全局默认输出方式（这张卡没单独设过时用它）
  const [streamDefault, setStreamDefault] = useState(DEFAULT_SETTINGS.stream)

  useEffect(() => {
    void (async () => {
      try {
        const [settings, list] = await Promise.all([
          window.api.settings.get(),
          window.api.providers.list()
        ])
        setStreamDefault(settings.stream)
        setCurrentId(settings.currentProviderId)
        setProviders(list)
      } catch {
        /* 读不到就用内置默认，不打扰用户 */
      }
    })()
  }, [])

  const current = providers.find((p) => p.id === currentId)
  const cardModel = (card.model ?? '').trim()
  const defaultModel = current?.model || DEFAULT_PROVIDER_MODEL
  const effectiveModel = cardModel !== '' ? cardModel : defaultModel
  const effectiveStream = typeof card.stream === 'boolean' ? card.stream : streamDefault

  /** 切换全局「使用中」的供应商 */
  const switchProvider = async (p: Provider) => {
    if (p.id === currentId) return
    try {
      const settings = await window.api.providers.setCurrent(p.id)
      setCurrentId(settings.currentProviderId)
      // 这张卡单独指定的模型若不在新供应商里，留着下一条必然失败——顺手改回新家的默认模型
      if (cardModel !== '' && p.models.length > 0 && !p.models.includes(cardModel)) {
        onPatch({ model: undefined })
        toast(`新供应商里没有「${cardModel}」，已改用它的默认模型「${p.model}」`)
        return
      }
      toast('已切换供应商，下一条消息生效')
    } catch (err) {
      toast(err instanceof Error ? err.message : '切换失败', 'error')
    }
  }

  /**
   * 点某个模型 = 供应商切到它所属那家 + 这张卡指定这个模型。
   * 再点一下已经打勾的那个 = 取消本卡指定，回到跟着供应商的默认模型走。
   */
  const pickModel = async (p: Provider, model: string) => {
    if (p.id === currentId && model === effectiveModel) {
      if (cardModel === '') {
        // 本来就是跟着默认走的，没什么可取消的
        toast(`这张卡用的就是供应商的默认模型「${p.model}」`)
        setOpen(false)
        return
      }
      onPatch({ model: undefined })
      setOpen(false)
      toast(`已改为跟随供应商的默认模型「${p.model}」`)
      return
    }

    if (p.id !== currentId) {
      try {
        const settings = await window.api.providers.setCurrent(p.id)
        setCurrentId(settings.currentProviderId)
      } catch (err) {
        toast(err instanceof Error ? err.message : '切换失败', 'error')
        return
      }
    }
    onPatch({ model })
    setOpen(false)
  }

  return (
    <div className="chat-settings">
      <button
        className="chat-settings-bar"
        title="切换供应商 / 模型 / 输出方式"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="chat-settings-model">
          {current ? barLabel(current) : '未配置供应商'} · {effectiveModel || '未设置模型'}
        </span>
        <span className="chat-settings-sep">·</span>
        <span>{effectiveStream ? '流式' : '非流式'}</span>
        <ChevronDownIcon size={15} className={`chat-settings-arrow${open ? ' open' : ''}`} />
      </button>

      {open && (
        <>
          {/* 点面板外任意处关闭 */}
          <div className="chat-settings-mask" onClick={() => setOpen(false)} />
          <div className="chat-settings-panel">
            <div className="field">
              <span className="field-label">供应商与模型</span>

              {providers.length === 0 && (
                <div className="ms-empty">
                  还没有配置供应商。
                  <button
                    className="btn-link"
                    onClick={() => {
                      setOpen(false)
                      navigate({ name: 'apiConfig' })
                    }}
                  >
                    去「API 配置」添加
                  </button>
                </div>
              )}

              <div className="ms-groups">
                {providers.map((p) => {
                  const isCurrent = p.id === currentId
                  // 挑过常用模型就只列挑过的这几个；一个都没挑过 → 列全部。
                  // 挑过但列表里没有的（手填的 / 已经下线的）追加在末尾，照样列出来
                  const common = p.commonModels
                  const shown =
                    common.length > 0
                      ? [
                          ...p.models.filter((m) => common.includes(m)),
                          ...common.filter((m) => !p.models.includes(m))
                        ]
                      : p.models
                  // 当前生效的那一行永远看得见：它不在这几个里面就补在最前面。
                  // 「任何状态下恰好只有一行打勾、且不会出现『有个模型在生效却看不见』」是 5.6 立下的硬不变式
                  const rows = shown.map((m) => ({ model: m, tag: '' }))
                  if (
                    isCurrent &&
                    effectiveModel !== '' &&
                    !rows.some((r) => r.model === effectiveModel)
                  ) {
                    rows.unshift({
                      model: effectiveModel,
                      tag: cardModel !== '' ? '本卡指定' : '默认'
                    })
                  }
                  return (
                    <div key={p.id} className="ms-group">
                      {/* 组标题：点一下只换供应商，不动模型。起过名时把地址放进悬停提示 */}
                      <button
                        className="ms-head"
                        title={p.name.trim() !== '' ? p.baseUrl : undefined}
                        onClick={() => void switchProvider(p)}
                      >
                        <span className="ms-head-url">{providerLabel(p)}</span>
                        {isCurrent && <span className="provider-badge">使用中</span>}
                      </button>

                      {rows.length > 0 && (
                        <div className="ms-items">
                          {rows.map((r) => {
                            // 打勾 = 这张卡当前生效的就是它（含「跟着供应商默认走」那种情况）
                            const active = isCurrent && r.model === effectiveModel
                            return (
                              <button
                                key={r.model}
                                className={`ms-item${active ? ' active' : ''}`}
                                onClick={() => void pickModel(p, r.model)}
                              >
                                <span className="ms-tick">{active && <CheckIcon size={15} />}</span>
                                <span className="ms-name">{r.model}</span>
                                {r.tag !== '' ? (
                                  <span className="ms-tag">{r.tag}</span>
                                ) : (
                                  active &&
                                  cardModel === '' &&
                                  r.model === p.model && <span className="ms-tag">默认</span>
                                )}
                              </button>
                            )
                          })}
                        </div>
                      )}

                      {p.models.length === 0 && shown.length === 0 && (
                        <div className="ms-empty">
                          还没获取过模型列表，去「API 配置」里编辑这条，点「获取模型列表」
                        </div>
                      )}

                      {common.length > 0 && (
                        <div className="ms-empty">
                          这条供应商只显示你挑的常用模型（{common.length} 个）；想改就去「API 配置」里编辑它。
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="field">
              <span className="field-label">输出方式</span>
              <div className="chip-row">
                <button
                  className={`chip chip-btn${effectiveStream ? ' chip-active' : ''}`}
                  onClick={() => onPatch({ stream: true })}
                >
                  流式（逐字显示）
                </button>
                <button
                  className={`chip chip-btn${!effectiveStream ? ' chip-active' : ''}`}
                  onClick={() => onPatch({ stream: false })}
                >
                  非流式（整段返回）
                </button>
              </div>
            </div>

            <span className="field-hint">
              供应商切换影响所有卡片；模型与输出方式只对这张卡生效。改完从下一条消息开始用新的。
            </span>
          </div>
        </>
      )}
    </div>
  )
}
