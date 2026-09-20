// 设置页：接收方式（流式/非流式）+ 温度 + 单次回复最大长度。
// 接口地址 / API Key / 模型 / 测试连接已移到「API 配置」栏目（见 ProviderPage）。
import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useAppStore } from '../store/appStore'
import { ArrowLeftIcon } from '../components/icons'

export default function SettingsPage() {
  const goBack = useAppStore((s) => s.goBack)
  const navigate = useAppStore((s) => s.navigate)
  const toast = useAppStore((s) => s.toast)

  const [form, setForm] = useState<Settings>({ ...DEFAULT_SETTINGS })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        setForm(await window.api.settings.get())
      } catch (err) {
        toast(err instanceof Error ? err.message : '设置读取失败', 'error')
      }
    })()
  }, [toast])

  const patch = (changes: Partial<Settings>) => setForm((f) => ({ ...f, ...changes }))

  const handleSave = async () => {
    setSaving(true)
    try {
      setForm(await window.api.settings.save(form))
      toast('已保存设置')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <button className="icon-btn" title="返回" onClick={goBack}>
          <ArrowLeftIcon size={20} />
        </button>
        <h1 className="page-title">设置</h1>
      </header>

      <div className="page-body">
        <section className="form-card">
          <div className="field">
            <span className="field-label">接收方式</span>
            <div className="chip-row">
              <button
                className={`chip chip-btn${form.stream !== false ? ' chip-active' : ''}`}
                onClick={() => patch({ stream: true })}
              >
                流式（逐字显示）
              </button>
              <button
                className={`chip chip-btn${form.stream === false ? ' chip-active' : ''}`}
                onClick={() => patch({ stream: false })}
              >
                非流式（一次返回整段）
              </button>
            </div>
            <span className="field-hint">
              默认流式，回复逐字出现。若服务商对逐字输出做了过滤、或流式经常被截断，改用非流式
              规避；非流式要等整段写完才显示。单张卡可在聊天页顶部状态条里单独改。
            </span>
          </div>

          <label className="field">
            <span className="field-label">
              温度（越高回答越随机）：{form.temperature.toFixed(1)}
            </span>
            <input
              className="field-range"
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={form.temperature}
              onChange={(e) => patch({ temperature: Number(e.target.value) })}
            />
            <span className="field-hint">角色扮演建议 0.7 ~ 1.0。</span>
          </label>

          <label className="field">
            <span className="field-label">单次回复最大长度</span>
            <input
              className="field-input"
              type="number"
              min={1}
              max={131072}
              value={form.maxTokens}
              onChange={(e) => patch({ maxTokens: Number(e.target.value) })}
            />
            <span className="field-hint">数字越大，AI 一次能写的内容越多。</span>
          </label>

          <div className="field">
            <span className="field-label">接口地址 / API Key / 模型</span>
            <button className="btn btn-sm" onClick={() => navigate({ name: 'apiConfig' })}>
              去「API 配置」管理
            </button>
            <span className="field-hint">
              这些接入信息按供应商分别保存，可存多条随时切换，已移到「API 配置」栏目。
            </span>
          </div>
        </section>
      </div>

      <footer className="page-footer">
        <button className="btn btn-primary" onClick={() => void handleSave()} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
      </footer>
    </div>
  )
}
