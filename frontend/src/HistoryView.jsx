import React, { useState, useEffect, useCallback, useRef } from 'react'

const API = '/api'

const s = {
  bar: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' },
  pill: (active) => ({
    padding: '5px 12px', borderRadius: 16, border: `1px solid ${active ? '#6366f1' : '#e5e7eb'}`,
    background: active ? '#6366f1' : '#fff', color: active ? '#fff' : '#555',
    fontSize: 12, fontWeight: 500, cursor: 'pointer',
  }),
  refreshBtn: { padding: '5px 12px', borderRadius: 7, border: '1px solid #ddd', background: '#fff', cursor: 'pointer', fontSize: 12 },
  card: { background: '#fff', borderRadius: 12, padding: 14, marginBottom: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.06)', cursor: 'pointer', transition: 'box-shadow 0.15s' },
  cardActive: { boxShadow: '0 4px 12px rgba(99,102,241,0.2)', borderLeft: '3px solid #6366f1' },
  cardRow: { display: 'flex', gap: 12, alignItems: 'flex-start' },
  thumb: { width: 90, height: 160, objectFit: 'cover', borderRadius: 6, background: '#f3f4f6', flexShrink: 0 },
  thumbPlaceholder: { width: 90, height: 160, borderRadius: 6, background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 24, color: '#bbb' },
  body: { flex: 1, minWidth: 0 },
  topLine: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' },
  status: (status) => ({
    fontSize: 11, padding: '2px 7px', borderRadius: 3, fontWeight: 600,
    background: status === 'completed' ? '#dcfce7' : status === 'failed' ? '#fee2e2' : '#dbeafe',
    color: status === 'completed' ? '#15803d' : status === 'failed' ? '#b91c1c' : '#1d4ed8',
  }),
  date: { fontSize: 11, color: '#888' },
  meta: { fontSize: 12, color: '#666', lineHeight: 1.6 },
  scores: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' },
  scoreChip: { fontSize: 11, padding: '2px 7px', borderRadius: 4, background: '#ede9fe', color: '#6d28d9' },
  expanded: { marginTop: 14, paddingTop: 14, borderTop: '1px solid #f1f5f9' },
  videoBox: { marginBottom: 14 },
  video: { width: '100%', maxWidth: 360, borderRadius: 8, display: 'block', background: '#000' },
  detailRow: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 12, marginTop: 8 },
  detailKey: { color: '#888' },
  detailVal: { color: '#222', wordBreak: 'break-all' },
  promptToggle: { marginTop: 10, fontSize: 11, color: '#6366f1', cursor: 'pointer', userSelect: 'none' },
  promptBox: { marginTop: 6, padding: 10, background: '#f8fafc', borderRadius: 6, fontSize: 11, fontFamily: 'monospace', whiteSpace: 'pre-wrap', maxHeight: 240, overflowY: 'auto', color: '#475569' },
  error: { padding: 8, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 12, color: '#b91c1c' },
  pager: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, margin: '16px 0' },
  pagerBtn: (disabled) => ({
    padding: '6px 14px', borderRadius: 7, fontSize: 13,
    border: '1px solid #ddd', background: disabled ? '#f5f5f5' : '#fff',
    color: disabled ? '#bbb' : '#444',
    cursor: disabled ? 'not-allowed' : 'pointer',
  }),
  pagerJump: { width: 50, padding: '4px 6px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13, textAlign: 'center', outline: 'none' },
  pagerInfo: { fontSize: 12, color: '#666' },
  empty: { textAlign: 'center', padding: 40, color: '#888', fontSize: 14 },
  loading: { textAlign: 'center', padding: 20, color: '#888', fontSize: 13 },
  publishBox: { marginTop: 10, padding: '10px 12px', background: '#f8fafc', borderRadius: 6, border: '1px solid #e2e8f0' },
  publishBoxPublished: { marginTop: 10, padding: '10px 12px', background: '#f0fdf4', borderRadius: 6, border: '1px solid #bbf7d0' },
  publishLabel: { fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' },
  publishBadge: { display: 'inline-block', padding: '2px 7px', borderRadius: 3, background: '#16a34a', color: '#fff', fontSize: 10, fontWeight: 700 },
  // 产品筛选下拉
  pdWrap: { position: 'relative', display: 'inline-block' },
  pdTrigger: (active) => ({
    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px 4px 5px', borderRadius: 16,
    border: `1px solid ${active ? '#6366f1' : '#e5e7eb'}`, background: active ? '#eef2ff' : '#fff',
    color: active ? '#4338ca' : '#555', fontSize: 12, fontWeight: 500, cursor: 'pointer', maxWidth: 220,
  }),
  pdTriggerThumb: { width: 22, height: 22, borderRadius: 4, objectFit: 'cover', background: '#f3f4f6', flexShrink: 0 },
  pdTriggerText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 },
  pdTriggerArrow: { fontSize: 9, color: '#9ca3af', flexShrink: 0 },
  pdPanel: {
    position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 20,
    background: '#fff', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
    border: '1px solid #e5e7eb', minWidth: 260, maxHeight: 360, overflowY: 'auto', padding: 4,
  },
  pdItem: (active) => ({
    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6,
    cursor: 'pointer', background: active ? '#eef2ff' : 'transparent',
    color: active ? '#4338ca' : '#333', fontSize: 13,
  }),
  pdItemThumb: { width: 32, height: 32, borderRadius: 5, objectFit: 'cover', background: '#f3f4f6', flexShrink: 0 },
  pdItemThumbPh: { width: 32, height: 32, borderRadius: 5, background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: '#bbb', flexShrink: 0 },
  pdItemName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  pdItemCount: { fontSize: 11, color: '#888', fontVariantNumeric: 'tabular-nums', flexShrink: 0 },
  publishRow: { display: 'flex', gap: 6, alignItems: 'center' },
  pubInput: { flex: 1, padding: '6px 9px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, outline: 'none' },
  pubBtn: (busy) => ({ padding: '6px 12px', borderRadius: 6, border: 'none', cursor: busy ? 'wait' : 'pointer', fontSize: 12, fontWeight: 600, background: busy ? '#a3a3a3' : '#6366f1', color: '#fff' }),
  pubBtnGhost: { padding: '6px 12px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', cursor: 'pointer', fontSize: 12, color: '#555' },
  pubMini: { fontSize: 11, color: '#666', marginTop: 4 },
}

function formatTime(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
function formatDuration(ms) {
  if (!ms) return ''
  const m = Math.floor(ms / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  return m > 0 ? `${m}m${sec}s` : `${sec}s`
}

// 根据 stepLabel 返回 icon + 上下文提示（与生成页保持一致）
function describeStep(label) {
  const l = label || ''
  if (/Snaptik/.test(l)) return { icon: '🔗', hint: '通常 ~5 秒' }
  if (/上传产品图|kie\.ai/.test(l) && /^Step 0|上传产品图/.test(l)) return { icon: '📤', hint: '通常 10-30 秒' }
  if (/Gemini 分析参考视频/.test(l)) return { icon: '🧠', hint: 'Pass 1，通常 30-90 秒' }
  if (/上传选中.*kie/.test(l)) return { icon: '🖼️', hint: '通常 10-20 秒' }
  if (/截取参考视频片段/.test(l)) return { icon: '✂️', hint: '通常 5-15 秒' }
  if (/程序化校验/.test(l)) return { icon: '🛡️', hint: '即时' }
  if (/二次评估/.test(l)) return { icon: '🔍', hint: 'Gemini 审查 prompt，~30 秒' }
  if (/修订/.test(l)) return { icon: '✏️', hint: '自动修订 — 最多 2 轮' }
  if (/创建.*Seedance/.test(l)) return { icon: '🎬', hint: '即时' }
  if (/Seedance 生成/.test(l)) return { icon: '⏳', hint: '排队 + 生成，5-25 分钟' }
  return { icon: '⚙️', hint: '' }
}

function fmtElapsed(seconds) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m${s}s` : `${s}s`
}

const STATUS_FILTERS = [
  { key: '', label: '全部' },
  { key: 'completed', label: '已完成' },
  { key: 'published', label: '✓ 已发布' },
  { key: 'unpublished', label: '○ 未发布' },
  { key: 'failed', label: '失败' },
  { key: 'pending', label: '处理中' },
  { key: 'processing', label: '处理中(初始)' },
]

function PublishToggle({ video, onChange }) {
  const [input, setInput] = useState(video.tiktokVideoId || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const save = async (clearMode = false) => {
    setBusy(true); setErr(null)
    try {
      const body = clearMode
        ? { isPublished: false, tiktokInput: null }
        : { tiktokInput: input }
      const r = await fetch(`${API}/generate/videos/${video.videoId}/published`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      onChange && onChange({ isPublished: data.isPublished, tiktokVideoId: data.tiktokVideoId })
      if (clearMode) setInput('')
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={video.isPublished ? s.publishBoxPublished : s.publishBox}>
      <div style={s.publishLabel}>
        <span>📤 TikTok 发布标记</span>
        {video.isPublished && <span style={s.publishBadge}>✓ 已发布</span>}
      </div>
      <div style={s.publishRow}>
        <input style={s.pubInput}
          placeholder="贴 TikTok 视频链接 或 纯数字 video_id"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && input.trim()) save(false) }} />
        <button style={s.pubBtn(busy)} disabled={busy || !input.trim()} onClick={() => save(false)}>
          {busy ? '保存中…' : (video.isPublished ? '更新' : '标记发布')}
        </button>
        {video.isPublished && (
          <button style={s.pubBtnGhost} disabled={busy} onClick={() => save(true)} title="撤销发布标记">
            撤销
          </button>
        )}
      </div>
      {video.tiktokVideoId && (
        <div style={s.pubMini}>
          当前 tiktok_video_id：<code>{video.tiktokVideoId}</code>
          <a href={`https://www.tiktok.com/video/${video.tiktokVideoId}`} target="_blank" rel="noreferrer" style={{ marginLeft: 8, color: '#6366f1' }}>↗ 打开</a>
        </div>
      )}
      {err && <div style={{ ...s.pubMini, color: '#b91c1c' }}>⚠️ {err}</div>}
    </div>
  )
}

const PAGE_SIZE = 20

const SCORE_LABELS = {
  product_accuracy:       { label: '产品准确性', tip: '视频中产品 vs 参考图的视觉匹配度' },
  character_consistency:  { label: '角色一致性', tip: '镜头切换中是否同一人' },
  natural_ugc_feel:       { label: 'UGC 真实感', tip: '像手机原生拍的 vs 一眼 AI' },
  anatomical_correctness: { label: '解剖正确性', tip: '手指/脸是否自然，无畸形' },
  audio_quality:          { label: '音频质量',   tip: '室内干净人声，无杂音' },
  no_text_leakage:        { label: '字幕零泄漏', tip: '画面里有没有漏出文字' },
  narrative_creativity:   { label: '叙事原创性', tip: '⚠ 反向：低分 = 忠实复刻参考（这是目标）', reversed: true },
  share_worthiness:       { label: '分享意愿',   tip: 'TikTok 用户愿不愿意转发/收藏' },
}

function ProductFilter({ products, productCounts, value, onChange, totalCount }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const selected = value ? products.find(p => p.productId === value) : null
  // 排序：先按 job 数降序，没记录的产品放最后；同数按 last_used_at（list 自带）
  const sorted = [...products].sort((a, b) => (productCounts[b.productId] || 0) - (productCounts[a.productId] || 0))

  return (
    <div style={s.pdWrap} ref={ref}>
      <div style={s.pdTrigger(!!value)} onClick={() => setOpen(o => !o)}>
        {selected?.coverImageUrl
          ? <img src={selected.coverImageUrl} alt="" style={s.pdTriggerThumb} />
          : <span style={{ ...s.pdTriggerThumb, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>📦</span>}
        <span style={s.pdTriggerText}>
          {selected ? (selected.name || '(未命名)') : '全部产品'}
        </span>
        <span style={s.pdTriggerArrow}>▼</span>
      </div>
      {open && (
        <div style={s.pdPanel}>
          <div style={s.pdItem(!value)} onClick={() => { onChange(''); setOpen(false) }}>
            <div style={{ ...s.pdItemThumbPh, fontSize: 16 }}>◯</div>
            <span style={s.pdItemName}>全部产品</span>
            <span style={s.pdItemCount}>{totalCount}</span>
          </div>
          {sorted.map(p => {
            const cnt = productCounts[p.productId] || 0
            return (
              <div key={p.productId} style={s.pdItem(value === p.productId)}
                onClick={() => { onChange(p.productId); setOpen(false) }}>
                {p.coverImageUrl
                  ? <img src={p.coverImageUrl} alt="" style={s.pdItemThumb} loading="lazy" />
                  : <div style={s.pdItemThumbPh}>📦</div>}
                <span style={s.pdItemName} title={p.name || p.productId}>{p.name || '(未命名)'}</span>
                <span style={s.pdItemCount}>{cnt}</span>
              </div>
            )
          })}
          {sorted.length === 0 && (
            <div style={{ padding: 12, fontSize: 12, color: '#888', textAlign: 'center' }}>
              暂无缓存产品
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ScoreGrid({ scores }) {
  if (!scores) return null
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 40px', gap: '4px 10px', marginTop: 8, fontSize: 12 }}>
      {Object.entries(SCORE_LABELS).map(([key, meta]) => {
        const val = scores[key]
        if (val == null) return null
        const pct = Math.max(0, Math.min(100, val * 10))
        // 反向分用灰色，正向用绿/橙/红
        const color = meta.reversed
          ? '#9ca3af'
          : val >= 8 ? '#16a34a'
          : val >= 6 ? '#f59e0b'
          : '#ef4444'
        return (
          <React.Fragment key={key}>
            <div style={{ color: '#555', fontWeight: 500 }} title={meta.tip}>
              {meta.label}{meta.reversed ? ' ⚠' : ''}
            </div>
            <div style={{ background: '#f3f4f6', borderRadius: 4, height: 16, position: 'relative', overflow: 'hidden' }}>
              <div style={{ width: pct + '%', height: '100%', background: color, transition: 'width 0.2s' }} />
            </div>
            <div style={{ fontWeight: 600, color, textAlign: 'right' }}>{val}</div>
          </React.Fragment>
        )
      })}
    </div>
  )
}

export default function HistoryView() {
  const [jobs, setJobs] = useState([])
  const [total, setTotal] = useState(0)
  const [statusFilter, setStatusFilter] = useState('')  // 默认显示全部，运行中 job 自然出现在顶部
  const [productFilter, setProductFilter] = useState('')  // '' = 全部产品；否则 productId
  const [products, setProducts] = useState([])  // 用于下拉选择
  const [productCounts, setProductCounts] = useState({})  // { productId: jobCount } — 显示每产品记录数
  const [sortBy, setSortBy] = useState('time')  // 'time' | 'quality'（按 video_judge_overall 降序，仅当前页内）
  const [page, setPage] = useState(1)  // 1-based
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(null)  // jobId
  const [details, setDetails] = useState({})  // jobId → 详情
  const [showPrompt, setShowPrompt] = useState({})
  const [jumpInput, setJumpInput] = useState('')
  // 运行中 job 的实时状态（每 8s 轮询）
  const [liveStatus, setLiveStatus] = useState({})  // jobId → { status, stepLabel, fetchedAt, stepStart }
  const [nowTick, setNowTick] = useState(Date.now())
  // 存为模板
  const [savedTemplateJobIds, setSavedTemplateJobIds] = useState(new Set())  // 已存过的 jobId
  const [saveFormOpen, setSaveFormOpen] = useState(null)  // jobId | null
  const [saveForm, setSaveForm] = useState({ video_url: '', views: '', orders: '', ctr: '', notes: '' })
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [saveTemplateErr, setSaveTemplateErr] = useState(null)

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const load = useCallback(async (targetPage) => {
    setLoading(true)
    try {
      const offset = (targetPage - 1) * PAGE_SIZE
      const qs = new URLSearchParams({ limit: PAGE_SIZE, offset, sortBy })
      if (statusFilter) qs.set('status', statusFilter)
      if (productFilter) qs.set('productId', productFilter)
      const r = await fetch(`${API}/generate/jobs?${qs}`)
      const data = await r.json()
      setJobs(data.jobs || [])
      setTotal(data.total || 0)
    } finally {
      setLoading(false)
    }
  }, [statusFilter, sortBy, productFilter])

  // 当 statusFilter / productFilter / sortBy / page 变化时刷新
  useEffect(() => { load(page) }, [load, page])
  // 切 filter / 排序 时回到第 1 页
  useEffect(() => { setPage(1) /* load 会被 page->1 变化触发 */ }, [statusFilter, sortBy, productFilter])

  // 拉产品列表 + 每产品记录数（mount 一次）
  useEffect(() => {
    fetch(`${API}/product/list`).then(r => r.json()).then(d => setProducts(d.items || [])).catch(() => {})
    fetch(`${API}/generate/job-product-counts`).then(r => r.json()).then(d => setProductCounts(d.counts || {})).catch(() => {})
  }, [])

  const goToPage = (p) => {
    const clamped = Math.max(1, Math.min(totalPages, p))
    setPage(clamped)
    setExpanded(null)
  }

  // 找出运行中的 jobs，每 8 秒轮询它们的最新状态
  useEffect(() => {
    const running = jobs.filter(j => j.status === 'pending' || j.status === 'processing')
    if (running.length === 0) return
    let cancelled = false
    const poll = async () => {
      for (const j of running) {
        try {
          const r = await fetch(`${API}/generate/status/${j.job_id}`)
          if (!r.ok) continue
          const d = await r.json()
          if (cancelled) return
          setLiveStatus(prev => {
            const prevForJob = prev[j.job_id]
            const stepStart = (prevForJob && prevForJob.stepLabel === d.stepLabel)
              ? prevForJob.stepStart
              : Date.now()
            return {
              ...prev,
              [j.job_id]: {
                status: d.status,
                stepLabel: d.stepLabel,
                step: d.step,
                videos: d.videos || [],
                error: d.error,
                fetchedAt: Date.now(),
                stepStart,
              },
            }
          })
          // 状态从 running 变成 completed/failed → 刷新列表（拿最终 videoUrl 和评分）
          if (j.status !== d.status && (d.status === 'completed' || d.status === 'failed')) {
            load(page)
          }
        } catch {}
      }
    }
    poll()  // 立即一次
    const t = setInterval(poll, 8000)
    return () => { cancelled = true; clearInterval(t) }
  }, [jobs, load, page])

  // 1s tick 给 elapsed 显示
  useEffect(() => {
    const hasRunning = jobs.some(j => j.status === 'pending' || j.status === 'processing')
    if (!hasRunning) return
    const t = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(t)
  }, [jobs])

  const [retrying, setRetrying] = useState({})  // jobId → true

  const handleRetryKie = async (jobId, e) => {
    e.stopPropagation()
    setRetrying(prev => ({ ...prev, [jobId]: true }))
    try {
      const res = await fetch(`${API}/generate/retry-kie/${jobId}`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) { alert(data.error || '重试失败'); return }
      // 本地把这条 job 改为 pending，触发轮询 useEffect 开始追踪
      setJobs(prev => prev.map(j => j.job_id !== jobId ? j : { ...j, status: 'pending' }))
      // 清掉详情缓存，展开时会重新拉取最终状态
      setDetails(prev => { const n = { ...prev }; delete n[jobId]; return n })
    } catch (err) {
      alert(err.message)
    } finally {
      setRetrying(prev => { const n = { ...prev }; delete n[jobId]; return n })
    }
  }

  const handleExpand = async (jobId) => {
    if (expanded === jobId) { setExpanded(null); return }
    setExpanded(jobId)
    if (details[jobId]) return  // 缓存命中
    try {
      const r = await fetch(`${API}/generate/jobs/${jobId}`)
      const data = await r.json()
      if (r.ok) setDetails(prev => ({ ...prev, [jobId]: data }))
    } catch {}
  }

  const openSaveForm = (jobId) => {
    setSaveFormOpen(jobId)
    setSaveForm({ video_url: '', views: '', orders: '', ctr: '', notes: '' })
    setSaveTemplateErr(null)
  }

  const handleSaveTemplate = async (job) => {
    if (!saveForm.video_url.trim()) { setSaveTemplateErr('请填写视频链接'); return }
    setSavingTemplate(true); setSaveTemplateErr(null)
    try {
      const detail = details[job.job_id]
      const prompt = detail?.videos?.[0]?.prompt || null
      const reviewScores = detail?.videos?.[0]?.videoJudgeScores
        ? JSON.stringify(detail.videos[0].videoJudgeScores)
        : null
      const body = {
        video_url: saveForm.video_url.trim(),
        job_id: job.job_id,
        prompt,
        review_scores: reviewScores,
        views: saveForm.views !== '' ? Number(saveForm.views) : null,
        orders: saveForm.orders !== '' ? Number(saveForm.orders) : null,
        ctr: saveForm.ctr !== '' ? Number(saveForm.ctr) : null,
        notes: saveForm.notes || null,
      }
      const r = await fetch(`${API}/templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.error || `HTTP ${r.status}`) }
      setSavedTemplateJobIds(prev => new Set([...prev, job.job_id]))
      setSaveFormOpen(null)
    } catch (e) {
      setSaveTemplateErr(e.message)
    } finally {
      setSavingTemplate(false)
    }
  }

  return (
    <div>
      <div style={s.bar}>
        {STATUS_FILTERS.map(f => (
          <div key={f.key} style={s.pill(statusFilter === f.key)} onClick={() => setStatusFilter(f.key)}>
            {f.label}
          </div>
        ))}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 8, paddingLeft: 8, borderLeft: '1px solid #e5e7eb' }}>
          <span style={{ fontSize: 11, color: '#888' }}>产品</span>
          <ProductFilter
            products={products}
            productCounts={productCounts}
            value={productFilter}
            onChange={setProductFilter}
            totalCount={Object.values(productCounts).reduce((a, b) => a + b, 0)}
          />
        </div>
        <button style={s.refreshBtn} onClick={() => load(page)}>🔄 刷新</button>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginLeft: 8, paddingLeft: 8, borderLeft: '1px solid #e5e7eb' }}>
          <span style={{ fontSize: 11, color: '#888' }}>排序</span>
          <div style={s.pill(sortBy === 'time')} onClick={() => setSortBy('time')}>时间</div>
          <div style={s.pill(sortBy === 'quality')} onClick={() => setSortBy('quality')}>质量分</div>
        </div>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#888' }}>共 {total} 条 · 第 {page} / {totalPages} 页</span>
      </div>

      {loading && jobs.length === 0 ? (
        <div style={s.loading}>加载中…</div>
      ) : jobs.length === 0 ? (
        <div style={s.empty}>没有任务记录</div>
      ) : (
        jobs.map(job => {
          // 用 liveStatus 覆盖（如果有的话）
          const live = liveStatus[job.job_id]
          const effectiveStatus = live?.status || job.status
          const isRunning = effectiveStatus === 'pending' || effectiveStatus === 'processing'
          const firstVideo = job.videos?.[0]
          const isExpanded = expanded === job.job_id
          const detail = details[job.job_id]
          return (
            <div key={job.job_id} style={{ ...s.card, ...(isExpanded ? s.cardActive : {}) }} onClick={() => handleExpand(job.job_id)}>
              <div style={s.cardRow}>
                {firstVideo?.posterUrl ? (
                  <img src={firstVideo.posterUrl} style={s.thumb} loading="lazy" alt="" />
                ) : firstVideo?.videoUrl ? (
                  <video src={firstVideo.videoUrl} style={s.thumb} preload="metadata" muted />
                ) : isRunning ? (
                  <div style={{ ...s.thumbPlaceholder, fontSize: 28 }}>{describeStep(live?.stepLabel).icon}</div>
                ) : (
                  <div style={s.thumbPlaceholder}>{effectiveStatus === 'failed' ? '❌' : '🎬'}</div>
                )}
                <div style={s.body}>
                  <div style={s.topLine}>
                    <span style={s.status(effectiveStatus)}>{effectiveStatus}</span>
                    {(job.videos || []).some(v => v.isPublished) && (
                      <span style={s.publishBadge}>✓ 已发布 {(job.videos || []).filter(v => v.isPublished).length}</span>
                    )}
                    <span style={s.date}>{formatTime(job.created_at)}</span>
                    {job.total_ms && <span style={s.date}>· 用时 {formatDuration(job.total_ms)}</span>}
                  </div>
                  {isRunning && (() => {
                    const lbl = live?.stepLabel || job.step_label || '准备中…'
                    const { icon, hint } = describeStep(lbl)
                    const stepElapsed = live?.stepStart ? Math.floor((nowTick - live.stepStart) / 1000) : 0
                    const totalElapsed = job.created_at ? Math.floor((nowTick - job.created_at) / 1000) : 0
                    return (
                      <div style={{ marginTop: 6, padding: '8px 10px', background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 7, fontSize: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 18 }}>{icon}</span>
                          <span style={{ fontWeight: 600, color: '#3730a3', flex: 1 }}>{lbl}</span>
                        </div>
                        <div style={{ marginTop: 4, color: '#6366f1', fontSize: 11 }}>
                          本步骤 {fmtElapsed(stepElapsed)} · 总耗时 {fmtElapsed(totalElapsed)}{hint && ` · ${hint}`}
                        </div>
                      </div>
                    )
                  })()}
                  <div style={s.meta}>
                    {job.product_id && <div>产品 ID：{job.product_id}</div>}
                    {job.category && <div>类目：{job.category}</div>}
                    {job.error_message && <div style={{ color: '#b91c1c' }}>错误：{job.error_message.slice(0, 120)}</div>}
                  </div>
                  {job.videos?.length > 0 && (
                    <div style={s.scores}>
                      <span style={s.scoreChip}>视频数 {job.videos.length}</span>
                      {firstVideo.reviewScore != null && <span style={s.scoreChip}>评审 {firstVideo.reviewScore}/10</span>}
                      {firstVideo.videoJudgeOverall != null && <span style={s.scoreChip}>质量 {firstVideo.videoJudgeOverall}/10</span>}
                      {firstVideo.diffJudgeOverall != null && <span style={s.scoreChip}>差异 {firstVideo.diffJudgeOverall}/10</span>}
                    </div>
                  )}
                </div>
              </div>

              {isExpanded && (
                <div style={s.expanded} onClick={e => e.stopPropagation()}>
                  {!detail ? (
                    <div style={s.loading}>加载详情…</div>
                  ) : (
                    <>
                      {detail.videos?.map(v => (
                        <div key={v.videoId} style={s.videoBox}>
                          {v.videoUrl ? (
                            <video src={v.videoUrl} poster={v.posterUrl || undefined} style={s.video} controls preload="none" />
                          ) : (
                            <div style={s.error}>视频地址缺失</div>
                          )}
                          <div style={s.detailRow}>
                            <span style={s.detailKey}>视频 ID</span>
                            <span style={s.detailVal}>{v.videoId}</span>
                            {v.videoJudgeOverall != null && <>
                              <span style={s.detailKey}>视频质量评分</span>
                              <span style={s.detailVal}><strong style={{ fontSize: 14 }}>{v.videoJudgeOverall}/10</strong> · {v.videoJudgeVerdict || ''}</span>
                            </>}
                            {v.diffJudgeOverall != null && <>
                              <span style={s.detailKey}>vs 标杆差异化</span>
                              <span style={s.detailVal}>{v.diffJudgeOverall}/10 · {v.diffJudgeVerdict || ''}</span>
                            </>}
                            {v.compressedScript && <>
                              <span style={s.detailKey}>口播</span>
                              <span style={{ ...s.detailVal, fontStyle: 'italic' }}>"{v.compressedScript}"</span>
                            </>}
                          </div>
                          {v.videoJudgeScores && (
                            <div style={{ marginTop: 12, padding: 12, background: '#fafafa', borderRadius: 6 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 6 }}>📊 各维度评分</div>
                              <ScoreGrid scores={v.videoJudgeScores} />
                              {v.videoJudgeScores.reference_match_notes && (
                                <div style={{ marginTop: 8, padding: 8, background: '#fff', borderRadius: 4, fontSize: 11, color: '#555' }}>
                                  <strong>参考图比对：</strong>{v.videoJudgeScores.reference_match_notes}
                                </div>
                              )}
                            </div>
                          )}
                          {v.prompt && (
                            <>
                              <div style={s.promptToggle} onClick={() => setShowPrompt(p => ({ ...p, [v.videoId]: !p[v.videoId] }))}>
                                {showPrompt[v.videoId] ? '▼ 隐藏完整 prompt' : '▶ 查看完整 prompt'}
                              </div>
                              {showPrompt[v.videoId] && <div style={s.promptBox}>{v.prompt}</div>}
                            </>
                          )}
                          <PublishToggle video={v} onChange={({ isPublished, tiktokVideoId }) => {
                            // 局部更新 details 缓存 + jobs 列表
                            setDetails(prev => {
                              const d = prev[job.job_id]
                              if (!d) return prev
                              return {
                                ...prev,
                                [job.job_id]: {
                                  ...d,
                                  videos: d.videos.map(x => x.videoId === v.videoId ? { ...x, isPublished, tiktokVideoId } : x),
                                },
                              }
                            })
                            setJobs(prev => prev.map(j => j.job_id !== job.job_id ? j : ({
                              ...j,
                              videos: (j.videos || []).map(x => x.videoId === v.videoId ? { ...x, isPublished, tiktokVideoId } : x),
                            })))
                          }} />
                        </div>
                      ))}
                      {/* 存为模板 */}
                      <div style={{ marginTop: 12 }}>
                        {savedTemplateJobIds.has(job.job_id) ? (
                          <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 600 }}>✅ 已存入模板库</span>
                        ) : saveFormOpen === job.job_id ? (
                          <div style={{ padding: 14, background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: '#333', marginBottom: 10 }}>⭐ 存为模板</div>
                            {saveTemplateErr && <div style={{ fontSize: 12, color: '#b91c1c', marginBottom: 8 }}>⚠️ {saveTemplateErr}</div>}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                              <input
                                style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13, outline: 'none' }}
                                placeholder="TikTok 发布后的视频链接 *"
                                value={saveForm.video_url}
                                onChange={e => setSaveForm(f => ({ ...f, video_url: e.target.value }))}
                              />
                              <div style={{ display: 'flex', gap: 8 }}>
                                <input
                                  style={{ flex: 1, padding: '7px 10px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13, outline: 'none' }}
                                  type="number" placeholder="播放量"
                                  value={saveForm.views}
                                  onChange={e => setSaveForm(f => ({ ...f, views: e.target.value }))}
                                />
                                <input
                                  style={{ flex: 1, padding: '7px 10px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13, outline: 'none' }}
                                  type="number" placeholder="出单数"
                                  value={saveForm.orders}
                                  onChange={e => setSaveForm(f => ({ ...f, orders: e.target.value }))}
                                />
                                <input
                                  style={{ flex: 1, padding: '7px 10px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13, outline: 'none' }}
                                  type="number" step="0.01" placeholder="CTR (%)"
                                  value={saveForm.ctr}
                                  onChange={e => setSaveForm(f => ({ ...f, ctr: e.target.value }))}
                                />
                              </div>
                              <input
                                style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13, outline: 'none' }}
                                placeholder="备注（可选）"
                                value={saveForm.notes}
                                onChange={e => setSaveForm(f => ({ ...f, notes: e.target.value }))}
                              />
                              <div style={{ display: 'flex', gap: 8 }}>
                                <button
                                  disabled={savingTemplate}
                                  onClick={() => handleSaveTemplate(job)}
                                  style={{ padding: '7px 16px', borderRadius: 6, border: 'none', background: '#6366f1', color: '#fff', fontSize: 12, fontWeight: 600, cursor: savingTemplate ? 'not-allowed' : 'pointer' }}>
                                  {savingTemplate ? '保存中…' : '提交'}
                                </button>
                                <button
                                  onClick={() => setSaveFormOpen(null)}
                                  style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid #ddd', background: '#fff', color: '#555', fontSize: 12, cursor: 'pointer' }}>
                                  取消
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <button
                            onClick={() => openSaveForm(job.job_id)}
                            style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #fbbf24', background: '#fef3c7', color: '#92400e', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                            ⭐ 存为模板
                          </button>
                        )}
                      </div>

                      {detail.job?.referenceVideoUrl && (
                        <div style={s.detailRow}>
                          <span style={s.detailKey}>参考视频</span>
                          <a style={s.detailVal} href={detail.job.referenceVideoUrl} target="_blank" rel="noreferrer">
                            {detail.job.referenceVideoAuthor && `@${detail.job.referenceVideoAuthor} · `}
                            {detail.job.referenceVideoUrl.slice(0, 80)}
                          </a>
                        </div>
                      )}
                      {detail.job?.error && (
                        <div style={{ ...s.error, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                          <span style={{ flex: 1 }}>{detail.job.error}</span>
                          {detail.job.tasks?.length > 0 && (
                            <button
                              disabled={retrying[job.job_id]}
                              onClick={e => handleRetryKie(job.job_id, e)}
                              style={{ flexShrink: 0, padding: '3px 10px', borderRadius: 5, border: '1px solid #fca5a5', background: '#fff', color: '#b91c1c', fontSize: 12, fontWeight: 600, cursor: retrying[job.job_id] ? 'not-allowed' : 'pointer' }}
                            >{retrying[job.job_id] ? '重试中…' : '🔄 重试 kie'}</button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })
      )}

      {totalPages > 1 && (
        <div style={s.pager}>
          <button style={s.pagerBtn(page === 1 || loading)} disabled={page === 1 || loading}
            onClick={() => goToPage(1)}>« 首页</button>
          <button style={s.pagerBtn(page === 1 || loading)} disabled={page === 1 || loading}
            onClick={() => goToPage(page - 1)}>‹ 上一页</button>
          <span style={s.pagerInfo}>第 {page} / {totalPages} 页</span>
          <button style={s.pagerBtn(page === totalPages || loading)} disabled={page === totalPages || loading}
            onClick={() => goToPage(page + 1)}>下一页 ›</button>
          <button style={s.pagerBtn(page === totalPages || loading)} disabled={page === totalPages || loading}
            onClick={() => goToPage(totalPages)}>末页 »</button>
          <span style={{ ...s.pagerInfo, marginLeft: 10 }}>跳转：</span>
          <input type="number" min="1" max={totalPages} style={s.pagerJump}
            value={jumpInput} placeholder={String(page)}
            onChange={e => setJumpInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const n = parseInt(jumpInput)
                if (!isNaN(n)) { goToPage(n); setJumpInput('') }
              }
            }} />
        </div>
      )}
    </div>
  )
}
