import React, { useState, useEffect, useRef, useCallback } from 'react'

const API = '/api'

// Fallback presets — 仅当产品没有 variants 时使用。有 variants 时优先用产品的 SKU 词表
const COLOR_PRESETS = ['Warm Beige', 'Black', 'White', 'Nude Pink', 'Brown', 'Red']
const REGIONS = ['SG', 'US', 'GB', 'MY', 'TH', 'PH', 'VN', 'ID', 'AU']
const PAGE_SIZE = 24  // 产品图分页

// normalize for matching: lowercase trim
const normColor = c => (c || '').trim().toLowerCase()

const s = {
  wrap: { display: 'flex', gap: 16, alignItems: 'flex-start' },
  listCol: { width: 320, flexShrink: 0 },
  detailCol: { flex: 1, minWidth: 0 },
  card: { background: '#fff', borderRadius: 14, padding: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.07)' },
  cardTitle: { fontSize: 13, fontWeight: 600, color: '#444', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.4 },
  listItem: (active) => ({
    padding: 10, borderRadius: 10, cursor: 'pointer',
    background: active ? '#eef2ff' : '#fff',
    border: `1px solid ${active ? '#6366f1' : '#eee'}`,
    marginBottom: 8, transition: 'all 0.12s',
    display: 'flex', gap: 10, alignItems: 'flex-start',
  }),
  listCover: { width: 54, height: 54, objectFit: 'cover', borderRadius: 6, border: '1px solid #eee', flexShrink: 0, background: '#f5f5f5' },
  listCoverPlaceholder: { width: 54, height: 54, borderRadius: 6, background: '#f3f4f6', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, color: '#bbb' },
  listMain: { flex: 1, minWidth: 0 },
  listName: { fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  listMeta: { fontSize: 11, color: '#888', display: 'flex', gap: 8, flexWrap: 'wrap' },
  metaTag: { display: 'inline-block', padding: '1px 6px', borderRadius: 3, background: '#f3f4f6', fontSize: 10 },
  curatedTag: { display: 'inline-block', padding: '1px 6px', borderRadius: 3, background: '#dcfce7', color: '#15803d', fontSize: 10, fontWeight: 600 },
  empty: { textAlign: 'center', color: '#999', fontSize: 14, padding: 40 },
  detailHeader: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' },
  nameInput: { flex: 1, minWidth: 200, padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, fontWeight: 600, outline: 'none' },
  pid: { fontSize: 12, color: '#888', fontFamily: 'monospace' },
  section: { marginBottom: 18 },
  sectionLabel: { fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px,1fr))', gap: 10 },
  thumbWrap: { position: 'relative', display: 'flex', flexDirection: 'column', gap: 4 },
  thumb: { width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 7, border: '1px solid #eee', display: 'block', background: '#f5f5f5' },
  inlineSelect: (tagged) => ({
    width: '100%', padding: '4px 6px', borderRadius: 6,
    border: `1px solid ${tagged ? '#a5b4fc' : '#e5e7eb'}`,
    background: tagged ? '#eef2ff' : '#fff',
    color: tagged ? '#4338ca' : '#999',
    fontSize: 11, fontWeight: tagged ? 600 : 500,
    cursor: 'pointer', outline: 'none',
    appearance: 'menulist',  // 保留原生下拉箭头
  }),
  rmBtn: { position: 'absolute', top: 3, right: 3, background: 'rgba(0,0,0,0.55)', color: '#fff', border: 'none', borderRadius: '50%', width: 22, height: 22, cursor: 'pointer', fontSize: 12, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 },
  dz: (active) => ({
    border: `2px dashed ${active ? '#6366f1' : '#ddd'}`,
    borderRadius: 10, padding: '20px', textAlign: 'center', cursor: 'pointer',
    background: active ? '#f0f0ff' : '#fafafa', transition: 'all 0.18s',
    color: '#999', fontSize: 13, marginTop: 8,
  }),
  btnGhost: { padding: '7px 14px', borderRadius: 7, border: '1px solid #ddd', background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500, color: '#555' },
  btnDanger: { padding: '8px 16px', borderRadius: 7, border: '1px solid #fecaca', background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500, color: '#b91c1c', marginTop: 16 },
  btnPrimary: (disabled) => ({ padding: '8px 14px', borderRadius: 7, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600, background: disabled ? '#c7c7c7' : '#6366f1', color: '#fff' }),
  input: { padding: '8px 10px', borderRadius: 7, border: '1px solid #ddd', fontSize: 13, outline: 'none', boxSizing: 'border-box' },
  select: { padding: '7px 9px', borderRadius: 7, border: '1px solid #ddd', fontSize: 13, background: '#fff', outline: 'none', cursor: 'pointer' },
  colorBadge: (color) => ({
    position: 'absolute', bottom: 3, left: 3, right: 3,
    background: color ? 'rgba(99,102,241,0.92)' : 'rgba(0,0,0,0.4)',
    color: '#fff', fontSize: 10, fontWeight: 600,
    padding: '2px 4px', borderRadius: 4, textAlign: 'center',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    pointerEvents: 'none',
  }),
  popMenu: {
    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
    background: '#fff', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
    padding: 6, zIndex: 10, minWidth: 140,
  },
  popItem: { padding: '6px 10px', cursor: 'pointer', fontSize: 13, borderRadius: 4 },
  bulkBar: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 },
  countChip: (color) => ({
    display: 'inline-block', padding: '1px 5px', borderRadius: 3,
    fontSize: 10, fontWeight: 600, marginRight: 4,
    background: color ? '#ede9fe' : '#f3f4f6',
    color: color ? '#6d28d9' : '#888',
  }),
  filterChip: (active, color) => ({
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '5px 10px', borderRadius: 16,
    fontSize: 12, fontWeight: 500,
    border: `1px solid ${active ? '#6366f1' : '#e5e7eb'}`,
    background: active ? '#6366f1' : '#fff',
    color: active ? '#fff' : color ? '#374151' : '#9ca3af',
    cursor: 'pointer', userSelect: 'none',
  }),
  filterBar: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #f1f5f9' },
  pageBar: { display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  pageBtn: (disabled, active) => ({
    padding: '4px 10px', borderRadius: 6,
    border: `1px solid ${active ? '#6366f1' : '#e5e7eb'}`,
    background: active ? '#6366f1' : '#fff',
    color: active ? '#fff' : disabled ? '#bbb' : '#555',
    fontSize: 12, fontWeight: 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
  }),
  recoBanner: {
    padding: '10px 14px', background: '#fef3c7', border: '1px solid #fde68a',
    borderRadius: 8, marginBottom: 12, fontSize: 13,
  },
  toast: (kind) => ({
    padding: '8px 12px', borderRadius: 7, fontSize: 13, marginTop: 8,
    background: kind === 'error' ? '#fef2f2' : '#f0fdf4',
    color: kind === 'error' ? '#b91c1c' : '#15803d',
    border: `1px solid ${kind === 'error' ? '#fecaca' : '#bbf7d0'}`,
  }),
}

function timeAgo(ts) {
  if (!ts) return ''
  const diffSec = Math.floor((Date.now() - ts) / 1000)
  if (diffSec < 60) return `${diffSec}秒前`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}小时前`
  return `${Math.floor(diffSec / 86400)}天前`
}

function ImageGrid({ urls, colors, onRemove, onSetColor, emptyText, knownColors }) {
  if (!urls || urls.length === 0) {
    return <div style={{ ...s.empty, padding: 20, fontSize: 13 }}>{emptyText}</div>
  }
  // 预设 + 该产品已用过的自定义色（去重，case-insensitive）
  const presetSet = new Set(COLOR_PRESETS.map(normColor))
  const extras = (knownColors || []).filter(c => c && !presetSet.has(normColor(c)))
  const allOptions = [...COLOR_PRESETS, ...extras]
  // 选项值前缀：__custom__ = 弹 prompt 输入；__clear__ = 清空
  const handleChange = (url, val) => {
    if (val === '__custom__') {
      const custom = prompt('自定义颜色名称（如 Mocha、身色等）：', '')
      if (custom !== null && custom.trim()) onSetColor(url, custom.trim())
      return
    }
    if (val === '__clear__') { onSetColor(url, ''); return }
    onSetColor(url, val)
  }
  return (
    <div style={s.grid}>
      {urls.map((u, i) => {
        const c = colors?.[i] || ''
        const cNorm = normColor(c)
        // 当前色不在 allOptions 里 → 临时加进去（避免 select 显示空）
        const showInList = c && !allOptions.some(o => normColor(o) === cNorm)
        return (
          <div key={u + i} style={s.thumbWrap}>
            <div style={{ position: 'relative' }}>
              <img src={u} alt="" style={s.thumb} loading="lazy" />
              {onRemove && (
                <button style={s.rmBtn} onClick={() => onRemove(u)} title="删除">×</button>
              )}
            </div>
            {onSetColor && (
              <select style={s.inlineSelect(!!c)}
                value={c}
                onChange={e => handleChange(u, e.target.value)}
                onClick={e => e.stopPropagation()}>
                <option value="">未标</option>
                {showInList && <option value={c}>{c}</option>}
                {allOptions.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                <option value="__custom__">+ 自定义…</option>
                {c && <option value="__clear__">清除</option>}
              </select>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ImageDrop({ onFiles, busy, color, onColorChange, knownColors }) {
  const [drag, setDrag] = useState(false)
  const ref = useRef()
  const handle = (raw) => {
    const files = Array.from(raw).filter(f => f.type.startsWith('image/'))
    if (files.length) onFiles(files)
  }
  const presetSet = new Set(COLOR_PRESETS.map(normColor))
  const extras = (knownColors || []).filter(c => c && !presetSet.has(normColor(c)))
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: '#666' }}>新图颜色（可选）：</span>
        <select style={s.select} value={color || ''} onChange={e => onColorChange(e.target.value)}>
          <option value="">— 未标 —</option>
          {[...COLOR_PRESETS, ...extras].map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div style={s.dz(drag)}
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); if (!busy) handle(e.dataTransfer.files) }}
        onClick={() => !busy && ref.current.click()}>
        <input ref={ref} type="file" accept="image/*" multiple style={{ display: 'none' }}
          onChange={e => { handle(e.target.files); e.target.value = '' }} />
        <div style={{ fontSize: 24, marginBottom: 4 }}>{busy ? '⏳' : '🖼️'}</div>
        <div style={{ fontSize: 13 }}>{busy ? '上传中…' : `拖拽或点击添加图片（多选）${color ? `· 默认色 ${color}` : ''}`}</div>
      </div>
    </div>
  )
}

function BulkTagBar({ onBulk, knownColors, sectionLabel }) {
  const [val, setVal] = useState('')
  const presetSet = new Set(COLOR_PRESETS.map(normColor))
  const extras = (knownColors || []).filter(c => c && !presetSet.has(normColor(c)))
  return (
    <div style={s.bulkBar}>
      <span style={{ fontSize: 11, color: '#888' }}>批量：</span>
      <select style={s.select} value={val} onChange={e => setVal(e.target.value)}>
        <option value="">— 选颜色 —</option>
        {[...COLOR_PRESETS, ...extras].map(c => <option key={c} value={c}>{c}</option>)}
      </select>
      <button style={s.btnPrimary(!val)} disabled={!val}
        onClick={() => { onBulk(val); setVal('') }}>全部标为</button>
      <button style={s.btnGhost} onClick={() => onBulk('')}>全部清除</button>
    </div>
  )
}

function CreateProductCard({ onCreated, showToast }) {
  const [url, setUrl] = useState('')
  const [region, setRegion] = useState('SG')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!url.trim()) return
    setBusy(true)
    try {
      const r = await fetch(`${API}/product/fetch?url=${encodeURIComponent(url)}&region=${region}`)
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      showToast(data.cached ? `已存在缓存：${data.productInfo?.name?.slice(0, 30) || data.productId}` : `已抓取并加入：${data.productInfo?.name?.slice(0, 30) || data.productId}`)
      setUrl('')
      onCreated(data.productId)
    } catch (e) {
      showToast(`抓取失败：${e.message}`, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div style={{ ...s.card, marginBottom: 12 }}>
      <div style={s.cardTitle}>➕ 新增产品（按 productId 自动去重）</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input style={{ ...s.input, flex: 1 }}
          placeholder="贴 TikTok Shop 链接或 product_id…"
          value={url} onChange={e => setUrl(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()} />
        <select style={{ ...s.select, width: 80 }} value={region} onChange={e => setRegion(e.target.value)}>
          {REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <button style={s.btnPrimary(busy || !url.trim())} disabled={busy || !url.trim()} onClick={submit}>
          {busy ? '抓取中…' : '抓取'}
        </button>
      </div>
    </div>
  )
}

export default function ProductManager() {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [nameEdit, setNameEdit] = useState('')
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadColor, setUploadColor] = useState('')
  const [toast, setToast] = useState(null)
  const [aiBusy, setAiBusy] = useState(false)
  // 产品的 SKU 词表（来自 productInfo.variants 第一轴）
  const [skuOptions, setSkuOptions] = useState({ axis: null, values: [] })
  // SKU 过滤：'' = 全部, '__untagged__' = 未标, 其他 = 具体 SKU
  const [skuFilter, setSkuFilter] = useState('')
  // 每个 section 的页码
  const [pages, setPages] = useState({ main: 1, detail: 1, user: 1 })
  // AI 推荐结果
  const [aiReco, setAiReco] = useState(null)
  const [aiRecoBusy, setAiRecoBusy] = useState(false)

  const showToast = (msg, kind = 'success') => {
    setToast({ msg, kind })
    setTimeout(() => setToast(null), 3500)
  }

  const loadList = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`${API}/product/list`)
      const data = await r.json()
      setProducts(data.items || [])
    } catch (e) {
      showToast(`加载产品列表失败：${e.message}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadDetail = useCallback(async (productId) => {
    try {
      const r = await fetch(`${API}/product/cache/${productId}`)
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`)
      const data = await r.json()
      setDetail(data.product)
      setNameEdit(data.product.name || '')
    } catch (e) {
      showToast(`加载详情失败：${e.message}`, 'error')
      setDetail(null)
    }
  }, [])

  useEffect(() => { loadList() }, [loadList])
  useEffect(() => {
    if (!selectedId) {
      setSkuOptions({ axis: null, values: [] }); setSkuFilter(''); setPages({ main: 1, detail: 1, user: 1 }); setAiReco(null)
      return
    }
    loadDetail(selectedId)
    // 拉 SKU 词表
    fetch(`${API}/product/${selectedId}/sku-options`)
      .then(r => r.json())
      .then(d => setSkuOptions({ axis: d.axis, values: d.values || [] }))
      .catch(() => setSkuOptions({ axis: null, values: [] }))
    setSkuFilter('')
    setPages({ main: 1, detail: 1, user: 1 })
    setAiReco(null)
  }, [selectedId, loadDetail])

  const handleUpload = async (files) => {
    if (!selectedId || files.length === 0) return
    setUploadBusy(true)
    try {
      const fd = new FormData()
      files.forEach(f => fd.append('images', f))
      if (uploadColor) fd.append('color', uploadColor)
      const r = await fetch(`${API}/product/${selectedId}/images`, { method: 'POST', body: fd })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setDetail(d => d ? { ...d, userImageUrls: data.userImageUrls, userImageColors: data.userImageColors, isCurated: true } : d)
      await loadList()
      const failedCount = (data.failed || []).length
      if (failedCount > 0) {
        showToast(`${data.added.length} 张上传成功，${failedCount} 张失败`, failedCount > data.added.length ? 'error' : 'success')
      } else {
        showToast(`${data.added.length} 张图片已添加${uploadColor ? `（颜色：${uploadColor}）` : ''}`)
      }
    } catch (e) {
      showToast(`上传失败：${e.message}`, 'error')
    } finally {
      setUploadBusy(false)
    }
  }

  // 给单张图打标
  const handleSetColor = async (url, color) => {
    if (!selectedId) return
    try {
      const r = await fetch(`${API}/product/${selectedId}/image-color`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, color }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      await loadDetail(selectedId)
      await loadList()
    } catch (e) {
      showToast(`打标失败：${e.message}`, 'error')
    }
  }

  // AI 推荐最佳 SKU
  const handleAiRecommend = async () => {
    if (!selectedId) return
    setAiRecoBusy(true)
    try {
      const r = await fetch(`${API}/product/${selectedId}/recommend-sku`)
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setAiReco(data)
      if (data.recommended) {
        showToast(`💡 AI 推荐：${data.recommended}`)
      } else {
        showToast(data.reason || 'AI 无法推荐', 'error')
      }
    } catch (e) {
      showToast(`推荐失败：${e.message}`, 'error')
    } finally {
      setAiRecoBusy(false)
    }
  }

  // AI 一键识别（默认只识别"未标"的图，避免覆盖已有人工标）
  const handleAiDetect = async (scope = 'untagged') => {
    if (!selectedId) return
    setAiBusy(true)
    try {
      const r = await fetch(`${API}/product/${selectedId}/ai-detect-colors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      await loadDetail(selectedId)
      await loadList()
      if (data.total === 0) {
        showToast(data.message || '没有需要识别的图', 'success')
      } else if ((data.failed || []).length > 0) {
        showToast(`AI 识别 ${data.taggedCount}/${data.total} 张成功，${data.failed.length} 张失败`, data.taggedCount > 0 ? 'success' : 'error')
      } else {
        showToast(`✨ AI 已标 ${data.taggedCount}/${data.total} 张`)
      }
    } catch (e) {
      showToast(`AI 识别失败：${e.message}`, 'error')
    } finally {
      setAiBusy(false)
    }
  }

  // 批量打标某个 section 全部图为 color（color='' 即清空）
  const handleBulkTag = async (urls, color) => {
    if (!selectedId || urls.length === 0) return
    try {
      const r = await fetch(`${API}/product/${selectedId}/bulk-tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls, color }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      await loadDetail(selectedId)
      await loadList()
      showToast(`${data.taggedCount} 张图已${color ? `标为 ${color}` : '清除颜色'}`)
    } catch (e) {
      showToast(`批量打标失败：${e.message}`, 'error')
    }
  }

  const handleRemoveImage = async (url) => {
    if (!selectedId) return
    try {
      const r = await fetch(`${API}/product/${selectedId}/images`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setDetail(d => d ? { ...d, userImageUrls: data.userImageUrls } : d)
      await loadList()
      showToast('已删除')
    } catch (e) {
      showToast(`删除失败：${e.message}`, 'error')
    }
  }

  const handleRename = async () => {
    if (!selectedId) return
    const newName = nameEdit.trim()
    if (!newName || newName === detail?.name) return
    try {
      const r = await fetch(`${API}/product/${selectedId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setDetail(d => d ? { ...d, name: newName } : d)
      await loadList()
      showToast('已重命名')
    } catch (e) {
      showToast(`重命名失败：${e.message}`, 'error')
    }
  }

  const handleDeleteProduct = async () => {
    if (!selectedId) return
    if (!confirm(`确认删除产品 "${detail?.name || selectedId}" 及其所有自定义图？此操作不可撤销。`)) return
    try {
      const r = await fetch(`${API}/product/${selectedId}`, { method: 'DELETE' })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setSelectedId(null)
      setDetail(null)
      await loadList()
      showToast('产品已删除')
    } catch (e) {
      showToast(`删除失败：${e.message}`, 'error')
    }
  }

  // 该产品已用过的所有颜色（用于补全下拉里的自定义色）
  const knownColors = detail
    ? Array.from(new Set([
        ...(detail.mainImageColors || []),
        ...(detail.detailImageColors || []),
        ...(detail.userImageColors || []),
      ].filter(Boolean)))
    : []

  // SKU vocab：产品有 variants 优先用，否则退到该产品已用过的颜色
  const dropdownVocab = skuOptions.values.length > 0
    ? Array.from(new Set([...skuOptions.values, ...knownColors]))  // 变体优先，旧 free-form 加在后面
    : knownColors

  // 单个 section 的过滤 + 分页渲染
  function renderSection({ key, title, subtitle, urls, colors, onRemove, extraAfter }) {
    const norm = c => (c || '').trim().toLowerCase()
    const all = (urls || []).map((u, i) => ({ u, c: (colors?.[i] || '') }))
    let filtered = all
    if (skuFilter === '__untagged__') filtered = all.filter(x => !x.c.trim())
    else if (skuFilter) {
      const t = norm(skuFilter)
      filtered = all.filter(x => norm(x.c) === t)
    }
    const total = filtered.length
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
    const page = Math.min(pages[key] || 1, totalPages)
    const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
    const visibleUrls = slice.map(x => x.u)
    const visibleColors = slice.map(x => x.c)

    return (
      <div style={s.section}>
        <div style={s.sectionLabel}>
          {title}（{filtered.length}{filtered.length !== all.length ? `/${all.length}` : ''}）
          <span style={{ color: '#888', fontWeight: 400, fontSize: 11 }}>{subtitle}</span>
        </div>
        {filtered.length > 0 && (
          <BulkTagBar onBulk={(c) => handleBulkTag(visibleUrls, c)} knownColors={dropdownVocab} />
        )}
        <ImageGrid urls={visibleUrls} colors={visibleColors}
          onRemove={onRemove} onSetColor={handleSetColor}
          knownColors={dropdownVocab}
          emptyText={all.length === 0 ? (key === 'user' ? '暂无自定义图。下方拖拽或点击添加。' : '无') : '该 SKU 筛选下无图'} />
        {totalPages > 1 && (
          <div style={s.pageBar}>
            <button style={s.pageBtn(page === 1, false)} disabled={page === 1}
              onClick={() => setPages({ ...pages, [key]: Math.max(1, page - 1) })}>‹ 上一页</button>
            <span style={{ fontSize: 12, color: '#666', margin: '0 8px' }}>第 {page} / {totalPages} 页</span>
            <button style={s.pageBtn(page === totalPages, false)} disabled={page === totalPages}
              onClick={() => setPages({ ...pages, [key]: Math.min(totalPages, page + 1) })}>下一页 ›</button>
          </div>
        )}
        {extraAfter}
      </div>
    )
  }

  return (
    <div style={s.wrap}>
      <div style={s.listCol}>
        <CreateProductCard
          showToast={(msg, kind) => showToast(msg, kind)}
          onCreated={async (pid) => { await loadList(); setSelectedId(pid) }} />
        <div style={s.card}>
          <div style={s.cardTitle}>产品列表（{products.length}）</div>
          {loading ? (
            <div style={s.empty}>加载中…</div>
          ) : products.length === 0 ? (
            <div style={s.empty}>暂无缓存产品。<br />上面贴 TikTok Shop 链接或 productId 抓取。</div>
          ) : (
            products.map(p => {
              const cc = p.colorCounts || {}
              return (
                <div key={p.productId} style={s.listItem(p.productId === selectedId)}
                  onClick={() => setSelectedId(p.productId)}>
                  {p.coverImageUrl
                    ? <img src={p.coverImageUrl} alt="" style={s.listCover} loading="lazy" />
                    : <div style={s.listCoverPlaceholder}>📦</div>}
                  <div style={s.listMain}>
                    <div style={s.listName}>{p.name || '(未命名)'}</div>
                    <div style={s.listMeta}>
                      <span style={s.metaTag}>{p.region || '-'}</span>
                      <span style={s.metaTag}>主{p.mainImageCount}+细{p.detailImageCount}</span>
                      {p.userImageCount > 0 && <span style={s.curatedTag}>+{p.userImageCount} 自定义</span>}
                      <span style={s.metaTag}>{timeAgo(p.lastUsedAt)}</span>
                    </div>
                    <div style={{ marginTop: 4 }}>
                      {Object.entries(cc).filter(([k]) => k).map(([k, v]) => (
                        <span key={k} style={s.countChip(k)}>{k} {v}</span>
                      ))}
                      {cc[''] > 0 && <span style={s.countChip('')}>未标 {cc['']}</span>}
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      <div style={s.detailCol}>
        {!detail ? (
          <div style={s.card}>
            <div style={s.empty}>← 从左侧选择一个产品</div>
          </div>
        ) : (
          <div style={s.card}>
            <div style={s.detailHeader}>
              <input style={s.nameInput} value={nameEdit}
                onChange={e => setNameEdit(e.target.value)}
                onBlur={handleRename}
                onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }} />
              <span style={s.pid}>id: {detail.productId}</span>
              {detail.isCurated && <span style={s.curatedTag}>已 curated（永不过期）</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
              <button style={s.btnPrimary(aiBusy)} disabled={aiBusy}
                onClick={() => handleAiDetect('untagged')}>
                {aiBusy ? '🪄 AI 识别中…' : '🪄 AI 识别未标 SKU'}
              </button>
              <button style={s.btnGhost} disabled={aiBusy}
                onClick={() => {
                  if (confirm('重新识别会覆盖所有已有标签（包括你手动改过的）。确定继续？')) {
                    handleAiDetect('all')
                  }
                }}>
                重新识别全部
              </button>
              <button style={s.btnPrimary(aiRecoBusy)} disabled={aiRecoBusy} onClick={handleAiRecommend}>
                {aiRecoBusy ? '🌟 评估中…' : '🌟 AI 推荐最佳 SKU'}
              </button>
              <span style={{ fontSize: 11, color: '#888', alignSelf: 'center' }}>
                {skuOptions.values.length > 0
                  ? `AI 会用产品的 ${skuOptions.values.length} 个 SKU（${skuOptions.axis}）作为词表`
                  : 'AI 自由识别（产品未提供 variants）'}
              </span>
            </div>

            {aiReco && aiReco.recommended && (
              <div style={s.recoBanner}>
                <strong>🌟 AI 推荐 SKU：{aiReco.recommended}</strong>
                {aiReco.counts?.[aiReco.recommended] != null && (
                  <span style={{ marginLeft: 8, color: '#92400e' }}>（{aiReco.counts[aiReco.recommended]} 张图）</span>
                )}
                <div style={{ fontSize: 12, color: '#78350f', marginTop: 4 }}>{aiReco.reason}</div>
              </div>
            )}

            {(() => {
              // 计算 SKU chip 数据（跨 main + detail + user 全图集）
              const allColors = [...(detail.mainImageColors || []), ...(detail.detailImageColors || []), ...(detail.userImageColors || [])]
              const total = allColors.length
              const skuCounts = {}
              for (const c of allColors) {
                const k = (c || '').trim() || '__untagged__'
                skuCounts[k] = (skuCounts[k] || 0) + 1
              }
              // 排序：产品 variants 顺序优先，然后未在 variants 里的（旧 free-form 标签），最后未标
              const orderedKeys = [
                ...skuOptions.values.filter(v => skuCounts[v] > 0),
                ...Object.keys(skuCounts).filter(k => k !== '__untagged__' && !skuOptions.values.some(v => normColor(v) === normColor(k))),
              ]
              return (
                <div style={s.filterBar}>
                  <div style={s.filterChip(skuFilter === '', true)} onClick={() => { setSkuFilter(''); setPages({ main: 1, detail: 1, user: 1 }) }}>
                    全部 {total}
                  </div>
                  {orderedKeys.map(k => {
                    const inVariants = skuOptions.values.some(v => normColor(v) === normColor(k))
                    return (
                      <div key={k} style={s.filterChip(skuFilter === k, true)}
                        onClick={() => { setSkuFilter(k); setPages({ main: 1, detail: 1, user: 1 }) }}>
                        {k} {skuCounts[k]}{!inVariants && skuOptions.values.length > 0 && <span style={{ fontSize: 9, marginLeft: 3, opacity: 0.7 }}>(非变体)</span>}
                      </div>
                    )
                  })}
                  {skuCounts['__untagged__'] > 0 && (
                    <div style={s.filterChip(skuFilter === '__untagged__', false)}
                      onClick={() => { setSkuFilter('__untagged__'); setPages({ main: 1, detail: 1, user: 1 }) }}>
                      未标 {skuCounts['__untagged__']}
                    </div>
                  )}
                </div>
              )
            })()}

            {renderSection({
              key: 'user',
              title: '自定义图片',
              subtitle: 'kie.ai 稳定 URL，永久有效',
              urls: detail.userImageUrls, colors: detail.userImageColors,
              onRemove: handleRemoveImage,
              extraAfter: (
                <ImageDrop onFiles={handleUpload} busy={uploadBusy}
                  color={uploadColor} onColorChange={setUploadColor}
                  knownColors={skuOptions.values.length > 0 ? skuOptions.values : knownColors} />
              ),
            })}

            {renderSection({
              key: 'main',
              title: '爬虫主图',
              subtitle: 'TikTok CDN，可能 24h 后失效',
              urls: detail.mainImageUrls, colors: detail.mainImageColors,
            })}

            {renderSection({
              key: 'detail',
              title: '爬虫详情图',
              subtitle: '同上',
              urls: detail.detailImageUrls, colors: detail.detailImageColors,
            })}

            {toast && <div style={s.toast(toast.kind)}>{toast.msg}</div>}

            <button style={s.btnDanger} onClick={handleDeleteProduct}>🗑 删除整个产品缓存</button>
          </div>
        )}
      </div>
    </div>
  )
}
