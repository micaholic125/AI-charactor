// API 配置：供应商（服务商）列表 + 新建/编辑/删除/切换使用中 + 测试连接。
// 一条供应商 = 名称（可选，只用于显示）+ 接口地址 + API Key + 模型名；**以接口地址为标识**。
// 规范见 docs/design.md §4、需求见 docs/requirements.md §3.7。
import { useEffect, useState } from 'react'
import type { Provider } from '@shared/types'
import { normalizeProviderUrl, providerLabel } from '@shared/types'
import { useAppStore } from '../store/appStore'
import { relativeTime } from '../utils/format'
import ModelPicker from '../components/ModelPicker'
import CommonModelsModal from '../components/CommonModelsModal'
import Modal from '../components/Modal'
import EmptyState from '../components/EmptyState'
import { CheckIcon, EditIcon, PlugIcon, PlusIcon, RefreshIcon, TrashIcon } from '../components/icons'

/** 常见服务商，点一下自动填好地址与模型（新手不用背网址） */
const PRESETS: Array<{ label: string; baseUrl: string; model: string }> = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { label: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
  { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' }
]

/** 空白表单（新建用） */
const emptyDraft = (): Provider => ({
  id: '',
  baseUrl: '',
  name: '',
  apiKey: '',
  model: 'deepseek-chat',
  models: [],
  modelsFetchedAt: 0,
  commonModels: [],
  createdAt: 0,
  updatedAt: 0
})

export default function ProviderPage() {
  const toast = useAppStore((s) => s.toast)
  const askConfirm = useAppStore((s) => s.askConfirm)

  const [providers, setProviders] = useState<Provider[]>([])
  const [currentId, setCurrentId] = useState('')
  const [loaded, setLoaded] = useState(false)
  /** 正在编辑的草稿；null = 弹窗关着。isNew 决定标题与「地址重复即合并」的提示 */
  const [draft, setDraft] = useState<{ provider: Provider; isNew: boolean } | null>(null)

  const reload = async () => {
    const [list, settings] = await Promise.all([window.api.providers.list(), window.api.settings.get()])
    setProviders(list)
    setCurrentId(settings.currentProviderId)
  }

  useEffect(() => {
    void (async () => {
      try {
        await reload()
      } catch (err) {
        toast(err instanceof Error ? err.message : '供应商读取失败', 'error')
      } finally {
        setLoaded(true)
      }
    })()
    // 只在挂载时读一次；之后的改动都由本页自己的操作触发刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 切换「使用中」：只改一个标识，重读整张表容易闪，单独更新 */
  const activate = async (p: Provider) => {
    if (p.id === currentId) return
    try {
      const settings = await window.api.providers.setCurrent(p.id)
      setCurrentId(settings.currentProviderId)
      toast('已切换供应商，下一条消息生效')
    } catch (err) {
      toast(err instanceof Error ? err.message : '切换失败', 'error')
    }
  }

  const remove = (p: Provider) => {
    askConfirm({
      title: '删除供应商',
      message: `确定删除「${providerLabel(p)}」${p.name.trim() !== '' ? `（${p.baseUrl}）` : ''}吗？该配置会被移除，已保存的聊天记录不受影响。`,
      confirmText: '删除',
      danger: true,
      onConfirm: async () => {
        try {
          const res = await window.api.providers.delete(p.id)
          setProviders(await window.api.providers.list())
          setCurrentId(res.currentProviderId)
          toast('已删除')
        } catch (err) {
          toast(err instanceof Error ? err.message : '删除失败', 'error')
        }
      }
    })
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">API 配置</h1>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => setDraft({ provider: emptyDraft(), isNew: true })}
        >
          <PlusIcon size={16} />
          新建
        </button>
      </header>

      <div className="page-body">
        {loaded && providers.length === 0 && (
          <EmptyState
            icon={<PlugIcon size={40} />}
            text={'还没有配置供应商\n点右上角「新建」，填上服务商给的接口地址和 API Key'}
          />
        )}

        <ul className="provider-list">
          {providers.map((p) => {
            const active = p.id === currentId
            return (
              <li key={p.id} className={`provider-row${active ? ' active' : ''}`}>
                <button className="provider-main" onClick={() => void activate(p)}>
                  <span className="provider-text">
                    <span className="provider-url">
                      <span className="provider-name">{providerLabel(p)}</span>
                      {/* 起过名时把接口地址缩成灰色小字跟在后面，免得「哪条是哪条」看不出来 */}
                      {p.name.trim() !== '' && <span className="provider-addr">{p.baseUrl}</span>}
                      {active && <span className="provider-badge">使用中</span>}
                    </span>
                    <span className="provider-sub">
                      {p.model}
                      <span className="provider-dot">·</span>
                      {/* 挑过常用模型时先说这个（聊天页只列这几个），再说全量有多少 */}
                      {p.commonModels.length > 0 && (
                        <>
                          常用 {p.commonModels.length} 个
                          <span className="provider-dot">·</span>
                        </>
                      )}
                      {p.models.length > 0
                        ? p.commonModels.length > 0
                          ? `共 ${p.models.length} 个模型`
                          : `${p.models.length} 个模型`
                        : '未获取模型'}
                      <span className="provider-dot">·</span>
                      {p.apiKey.trim() !== '' ? '已填 Key' : '未填 Key'}
                      {p.updatedAt > 0 && (
                        <>
                          <span className="provider-dot">·</span>
                          {relativeTime(p.updatedAt)}更新
                        </>
                      )}
                    </span>
                  </span>
                </button>
                <div className="provider-actions">
                  <button
                    className="icon-btn"
                    title="编辑"
                    onClick={() => setDraft({ provider: { ...p }, isNew: false })}
                  >
                    <EditIcon size={18} />
                  </button>
                  <button className="icon-btn danger" title="删除" onClick={() => remove(p)}>
                    <TrashIcon size={18} />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>

        {providers.length > 0 && (
          <p className="field-hint provider-tip">
            点一条即切换为「使用中」，之后所有聊天都走它的接口地址与 Key，全局生效。
          </p>
        )}
      </div>

      {draft && (
        <ProviderForm
          initial={draft.provider}
          isNew={draft.isNew}
          onClose={() => setDraft(null)}
          onSaved={async () => {
            setDraft(null)
            await reload()
          }}
        />
      )}
    </div>
  )
}

// ---------- 新建 / 编辑弹窗 ----------

interface FormProps {
  initial: Provider
  isNew: boolean
  onClose: () => void
  onSaved: () => Promise<void>
}

function ProviderForm({ initial, isNew, onClose, onSaved }: FormProps) {
  const toast = useAppStore((s) => s.toast)
  const [form, setForm] = useState<Provider>(initial)
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; detail?: string } | null>(
    null
  )
  const [fetching, setFetching] = useState(false)
  const [modelsMsg, setModelsMsg] = useState<{ ok: boolean; text: string } | null>(null)
  /** 「挑常用模型」二级弹窗开着没有 */
  const [picking, setPicking] = useState(false)

  const patch = (changes: Partial<Provider>) => {
    setForm((f) => ({ ...f, ...changes }))
    setTestResult(null)
  }

  /** 「常用模型」右边那句灰字摘要：挑过的列前 5 个，没挑过就引导一句 */
  const commonSummary = (): string => {
    const list = form.commonModels
    if (list.length === 0) {
      return '还没挑过 —— 聊天页里会显示这家接口的全部模型；挑几个常用的，那边就只显示这几个。'
    }
    const head = list.slice(0, 5).join('、')
    return `已挑 ${list.length} 个：${head}${list.length > 5 ? '…' : ''}`
  }

  /** 撞上了别的供应商的地址：提示会被合并，避免用户以为存了两条 */
  const [all, setAll] = useState<Provider[]>([])
  useEffect(() => {
    void window.api.providers.list().then(setAll).catch(() => setAll([]))
  }, [])
  const normalized = normalizeProviderUrl(form.baseUrl)
  const clashing = all.find((p) => p.id === normalized && p.id !== normalizeProviderUrl(initial.id))

  /**
   * 拉取可用模型列表。成功时把列表写进表单（保存时一起落盘）；
   * 当前模型不在拉回来的列表里也不动它——用户可能是有意手填的。
   * 返回拉到的模型（没拉到返回 null），供「保存」复用。
   */
  const fetchModels = async (): Promise<string[] | null> => {
    setFetching(true)
    try {
      const res = await window.api.providers.fetchModels(form)
      if (!res.ok) {
        setModelsMsg({ ok: false, text: res.message ?? '获取失败' })
        return null
      }
      setForm((f) => ({
        ...f,
        models: res.models,
        modelsFetchedAt: Date.now(),
        // 还没选过模型就顺手用列表里第一个顶上
        model: f.model.trim() !== '' ? f.model : (res.models[0] ?? '')
      }))
      setModelsMsg({ ok: true, text: `共 ${res.models.length} 个模型 · 刚刚更新` })
      return res.models
    } catch (err) {
      setModelsMsg({ ok: false, text: err instanceof Error ? err.message : '获取失败' })
      return null
    } finally {
      setFetching(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      // 保存前顺手拉一次模型列表（地址和 Key 都填了才拉）；
      // 拉不到不拦保存——手动填的模型名照样能用
      let next = form
      if (form.baseUrl.trim() !== '' && form.apiKey.trim() !== '') {
        try {
          const res = await window.api.providers.fetchModels(form)
          if (res.ok) {
            next = {
              ...form,
              models: res.models,
              modelsFetchedAt: Date.now(),
              model: form.model.trim() !== '' ? form.model : (res.models[0] ?? '')
            }
          }
        } catch {
          /* 拉不到就算了，不打扰用户 */
        }
      }
      await window.api.providers.save(next)
      toast('已保存，并设为使用中')
      await onSaved()
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await window.api.settings.test(form)
      if (res.ok) {
        setTestResult({ ok: true, message: '连接成功，可以开始聊天了' })
      } else {
        setTestResult({ ok: false, message: res.message ?? '连接失败', detail: res.detail })
      }
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : '连接失败' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Modal
      title={isNew ? '新建供应商' : '编辑供应商'}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn" onClick={() => void handleTest()} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button className="btn btn-primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="field">
        <span className="field-label">常用服务商（点一下自动填地址和模型）</span>
        <div className="chip-row">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              className="chip chip-btn"
              onClick={() =>
                // 名称还空着就顺手填上预设名（点「DeepSeek」就叫 DeepSeek），已经自己填过的不动
                patch({
                  baseUrl: p.baseUrl,
                  model: p.model,
                  name: form.name.trim() === '' ? p.label : form.name
                })
              }
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <label className="field">
        <span className="field-label">名称（可选）</span>
        <input
          className="field-input"
          value={form.name}
          placeholder="例如：DeepSeek 官方"
          onChange={(e) => {
            // 名称不影响连通性，所以不走 patch（那会把「测试连接」的结果清掉）
            const name = e.target.value
            setForm((f) => ({ ...f, name }))
          }}
        />
        <span className="field-hint">
          给这条配置起个好记的名字，列表和聊天页都显示它；留空就显示接口地址。
        </span>
      </label>

      <label className="field">
        <span className="field-label">接口地址</span>
        <input
          className="field-input"
          value={form.baseUrl}
          placeholder="https://api.deepseek.com/v1"
          spellCheck={false}
          onChange={(e) => patch({ baseUrl: e.target.value })}
        />
        <span className="field-hint">
          填服务商给的地址即可，通常以 /v1 结尾。只填域名也能用，会自动补全。
          <br />
          地址是这条配置的身份：改地址等于换了一条配置（名称会一起带过去）。
        </span>
        {clashing && (
          <span className="field-hint field-warn">
            这个地址已经有一条配置了，保存会覆盖那一条（名称、Key、模型都会被覆盖）。
          </span>
        )}
      </label>

      <label className="field">
        <span className="field-label">API Key</span>
        <div className="input-with-btn">
          <input
            className="field-input"
            type={showKey ? 'text' : 'password'}
            value={form.apiKey}
            placeholder="粘贴你的 API Key"
            spellCheck={false}
            onChange={(e) => patch({ apiKey: e.target.value })}
          />
          <button className="btn btn-sm" onClick={() => setShowKey((v) => !v)}>
            {showKey ? '隐藏' : '显示'}
          </button>
        </div>
        <span className="field-hint">只保存在你自己的电脑上，不会上传到任何地方。</span>
      </label>

      <div className="field">
        <span className="field-label">可用模型</span>
        <div className="fetch-row">
          <button
            className="btn btn-sm"
            onClick={() => void fetchModels()}
            disabled={fetching || form.baseUrl.trim() === ''}
          >
            <RefreshIcon size={16} className={fetching ? 'spin' : undefined} />
            {fetching ? '获取中…' : '获取模型列表'}
          </button>
          {modelsMsg ? (
            <span className={`field-hint${modelsMsg.ok ? '' : ' field-warn'}`}>
              {modelsMsg.text}
            </span>
          ) : (
            <span className="field-hint">
              {form.models.length > 0
                ? `已保存 ${form.models.length} 个模型 · ${relativeTime(form.modelsFetchedAt)}更新`
                : '填好接口地址和 API Key 后，点左边按钮从服务商拉取'}
            </span>
          )}
        </div>
      </div>

      <div className="field">
        <span className="field-label">常用模型（可选）</span>
        <div className="fetch-row">
          <button className="btn btn-sm" onClick={() => setPicking(true)}>
            <CheckIcon size={16} /> 挑常用模型
          </button>
          <span className="field-hint">{commonSummary()}</span>
        </div>
        <span className="field-hint">
          挑几个常用的，聊天页切换模型时就只列这几个；一个都不挑则照旧列全部。卡片编辑页不受影响，照旧列全部。
        </span>
      </div>

      <label className="field">
        <span className="field-label">默认模型</span>
        <ModelPicker
          value={form.model}
          onChange={(v) => patch({ model: v })}
          groups={[{ label: '这条供应商的模型', models: form.models }]}
        />
        <span className="field-hint">
          这条供应商默认用的模型；每张卡可以在编辑页或聊天页状态条单独换。
        </span>
      </label>

      {testResult && (
        <div className={`test-result ${testResult.ok ? 'ok' : 'bad'}`}>
          <div className="test-result-line">
            {testResult.ok && <CheckIcon size={18} />}
            {testResult.message}
          </div>
          {testResult.detail && <div className="test-result-detail">{testResult.detail}</div>}
        </div>
      )}

      <span className="field-hint">保存后这条会自动成为「使用中」的供应商。</span>

      {picking && (
        <CommonModelsModal
          models={form.models}
          selected={form.commonModels}
          onCancel={() => setPicking(false)}
          onConfirm={(next) => {
            // 只改表单，等点「保存」才落盘——取消整个表单就什么都不留
            patch({ commonModels: next })
            setPicking(false)
          }}
        />
      )}
    </Modal>
  )
}
