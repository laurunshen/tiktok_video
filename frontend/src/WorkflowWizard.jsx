import React, { useState, useRef, useEffect, useCallback } from 'react'

const API = '/api'

const CATEGORIES = [
  { value: 'lingerie', label: '👙 内衣 / 塑形' },
  { value: 'general', label: '📦 通用品类' },
]

const IMAGE_MODELS = [
  { value: 'gpt-image-2-image-to-image', label: 'GPT-Image-2' },
  { value: 'seedream/5-lite-image-to-image', label: 'Seedream 5 Lite' },
]

const s = {
  wrap: { padding: '0 0 60px' },
  card: { background: '#fff', borderRadius: 14, padding: 24, marginBottom: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.07)' },
  cardTitle: { fontSize: 16, fontWeight: 700, color: '#111', marginBottom: 16 },
  row: { display: 'flex', gap: 14, flexWrap: 'wrap' },
  field: { flex: 1, minWidth: 160, marginBottom: 14 },
  label: { display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 5 },
  input: { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, outline: 'none', boxSizing: 'border-box' },
  select: { padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13, outline: 'none', background: '#fff' },
  textarea: { width: '100%', minHeight: 64, padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13, resize: 'vertical', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  btn: { padding: '10px 20px', borderRadius: 8, border: 'none', background: '#6366f1', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  btnGhost: { padding: '8px 14px', borderRadius: 8, border: '1px solid #ddd', background: '#fff', color: '#555', fontSize: 13, cursor: 'pointer' },
  pill: (st) => ({ display: 'inline-block', padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: st === 'failed' ? '#fee2e2' : /await|completed/.test(st) ? '#dcfce7' : '#dbeafe', color: st === 'failed' ? '#b91c1c' : /await|completed/.test(st) ? '#15803d' : '#1d4ed8' }),
  segCard: { border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, marginBottom: 12, background: '#fafafa' },
  segHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 13, color: '#374151' },
  err: { padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 13, marginBottom: 16 },
  note: { fontSize: 12, color: '#6b7280', marginTop: 6 },
  gallery: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 12, marginTop: 8 },
  modelCard: (on) => ({ border: `2px solid ${on ? '#6366f1' : '#e5e7eb'}`, borderRadius: 10, padding: 6, cursor: 'pointer', background: on ? '#eef2ff' : '#fff', textAlign: 'center' }),
  modelImg: { width: '100%', height: 150, objectFit: 'cover', borderRadius: 6, background: '#f3f4f6' },
  kfImg: { width: 120, height: 213, objectFit: 'cover', borderRadius: 6, background: '#f3f4f6', border: '1px solid #e5e7eb' },
}

export default function WorkflowWizard() {
  const [refVideo, setRefVideo] = useState(null)
  const [tiktokUrl, setTiktokUrl] = useState('')
  const [products, setProducts] = useState([])
  const [productInfo, setProductInfo] = useState(null)
  const [loadingProduct, setLoadingProduct] = useState(false)
  const [productSkuColor, setProductSkuColor] = useState('')      // '' = 不过滤
  const [productColorInventory, setProductColorInventory] = useState(null)
  const [productAllImages, setProductAllImages] = useState(null)  // {main:[{url,color}],detail,user}
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('lingerie')
  const [duration, setDuration] = useState('auto')   // 'auto' = 由模型按参考视频决定；或具体秒数
  const [resolution, setResolution] = useState('480p')

  const [workflowId, setWorkflowId] = useState(null)
  const [wf, setWf] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [scripts, setScripts] = useState({})
  const [confirming, setConfirming] = useState(false)

  // 模特库 + 首帧
  const [models, setModels] = useState([])
  const [profiles, setProfiles] = useState([])
  const [genLibBusy, setGenLibBusy] = useState(false)
  const [showLib, setShowLib] = useState(true)
  const [imageModel, setImageModel] = useState(IMAGE_MODELS[0].value)
  const [kfPrompts, setKfPrompts] = useState({})  // 编辑中的首帧提示词
  const [lfPrompts, setLfPrompts] = useState({})  // 编辑中的尾帧提示词
  const [vpPrompts, setVpPrompts] = useState({})  // 编辑中的视频提示词
  const [aiResults, setAiResults] = useState({})  // key `${step}-${idx}` → {ok,issues,suggestion,rewritten}
  const [aiBusy, setAiBusy] = useState({})

  const pollRef = useRef(null)
  const modelsPollRef = useRef(null)

  const stopPoll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }, [])
  const stopModelsPoll = useCallback(() => {
    if (modelsPollRef.current) { clearInterval(modelsPollRef.current); modelsPollRef.current = null }
  }, [])
  useEffect(() => () => { stopPoll(); stopModelsPoll() }, [stopPoll, stopModelsPoll])

  useEffect(() => {
    if (wf?.segments?.length && Object.keys(scripts).length === 0) {
      const init = {}
      wf.segments.forEach(seg => { init[seg.index] = seg.script || '' })
      setScripts(init)
    }
  }, [wf, scripts])

  // 拉取缓存产品库（与生成页一致）
  const fetchProducts = useCallback(async () => {
    try {
      const r = await fetch(`${API}/product/list`)
      const d = await r.json()
      setProducts(d.items || [])
    } catch (e) { console.error('fetch products error', e) }
  }, [])
  useEffect(() => { fetchProducts() }, [fetchProducts])

  // 选中缓存产品 → 构造 productInfo + SKU 颜色清单（与生成页一致）
  const selectProduct = async (productId) => {
    setLoadingProduct(true); setError(null)
    try {
      const r = await fetch(`${API}/product/cache/${productId}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '加载产品失败')
      const p = d.product
      const rawImages = {
        main: (p.mainImageUrls || []).map((u, i) => ({ url: u, color: (p.mainImageColors || [])[i] || '' })),
        detail: (p.detailImageUrls || []).map((u, i) => ({ url: u, color: (p.detailImageColors || [])[i] || '' })),
        user: (p.userImageUrls || []).map((u, i) => ({ url: u, color: (p.userImageColors || [])[i] || '' })),
      }
      const inv = {}
      for (const arr of [rawImages.main, rawImages.detail, rawImages.user]) {
        for (const { color } of arr) { const k = (color || '').trim(); if (k) inv[k] = (inv[k] || 0) + 1 }
      }
      setProductAllImages(rawImages)
      setProductColorInventory(inv)
      setProductSkuColor('')
      setProductInfo({
        ...p.productInfo,
        productId: p.productId,
        mainImageUrls: p.mainImageUrls || [],
        detailImageUrls: [...(p.detailImageUrls || []), ...(p.userImageUrls || [])],
      })
    } catch (e) { setError(e.message) } finally { setLoadingProduct(false) }
  }

  // SKU 颜色变化 → 按颜色过滤 productInfo 的图（与生成页一致）
  useEffect(() => {
    if (!productAllImages) return
    const norm = c => (c || '').trim().toLowerCase()
    const target = norm(productSkuColor)
    const pick = arr => (target ? arr.filter(x => norm(x.color) === target) : arr).map(x => x.url)
    setProductInfo(pi => pi ? ({
      ...pi,
      mainImageUrls: pick(productAllImages.main),
      detailImageUrls: [...pick(productAllImages.detail), ...pick(productAllImages.user)],
    }) : pi)
  }, [productSkuColor, productAllImages])

  const fetchModels = useCallback(async () => {
    try {
      const r = await fetch(`${API}/workflow/models`)
      const d = await r.json()
      setModels(d.models || [])
      setProfiles(d.profiles || [])
    } catch (e) { console.error('fetch models error', e) }
  }, [])
  useEffect(() => { fetchModels() }, [fetchModels])  // 进页面就拉模特库，顶部常驻入口

  const poll = useCallback(async (id) => {
    try {
      const r = await fetch(`${API}/workflow/${id}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '查询失败')
      setWf(d)
      // 关键帧生成阶段持续轮询；进入需人工的状态则停轮询
      const settled = ['await_scripts', 'await_model', 'await_keyframes', 'await_prompts', 'completed', 'failed']
      if (d.status === 'failed') { setError(d.error || '失败'); stopPoll(); setLoading(false) }
      else if (settled.includes(d.status)) { stopPoll(); setLoading(false) }
    } catch (e) { console.error('workflow poll error', e) }
  }, [stopPoll])

  const startPoll = useCallback((id) => {
    stopPoll(); poll(id); pollRef.current = setInterval(() => poll(id), 4000)
  }, [poll, stopPoll])

  // 进入选模特/生成首帧阶段时拉模特库
  useEffect(() => {
    if (wf && ['await_model', 'generating_keyframes', 'await_keyframes'].includes(wf.status)) fetchModels()
  }, [wf?.status, fetchModels])

  // 生成阶段（关键帧/视频）需要继续轮询工作流
  useEffect(() => {
    if ((wf?.status === 'generating_keyframes' || wf?.status === 'generating_videos') && workflowId && !pollRef.current) startPoll(workflowId)
  }, [wf?.status, workflowId, startPoll])

  const submit = async () => {
    if (!refVideo && !tiktokUrl.trim()) { setError('请上传参考视频或填写 TikTok 链接'); return }
    if (!productInfo) { setError('请选择一个产品'); return }
    setError(null); setLoading(true); setWf(null); setScripts({})
    const fd = new FormData()
    if (refVideo) fd.append('referenceVideo', refVideo)
    if (tiktokUrl.trim()) fd.append('tiktokVideoUrl', tiktokUrl.trim())
    fd.append('productInfo', JSON.stringify(productInfo))
    fd.append('userDescription', description)
    fd.append('category', category)
    fd.append('duration', duration)
    fd.append('resolution', resolution)
    try {
      const r = await fetch(`${API}/workflow`, { method: 'POST', body: fd })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '启动失败')
      setWorkflowId(d.workflowId); startPoll(d.workflowId)
    } catch (e) { setError(e.message); setLoading(false) }
  }

  const confirmScripts = async () => {
    setConfirming(true); setError(null)
    const segments = Object.entries(scripts).map(([index, script]) => ({ index: Number(index), script }))
    try {
      const r = await fetch(`${API}/workflow/${workflowId}/scripts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments, confirm: true }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '确认失败')
      setWf(d)
    } catch (e) { setError(e.message) } finally { setConfirming(false) }
  }

  const predefineLibrary = async () => {
    setGenLibBusy(true); setError(null)
    try {
      // 模特库用 text-to-image（无参考图），由所选模型族推导对应变体
      const textModel = imageModel.replace('image-to-image', 'text-to-image')
      await fetch(`${API}/workflow/models/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageModel: textModel }),
      })
      // 轮询模特库直到生成齐（最多 ~3 分钟）
      stopModelsPoll()
      let ticks = 0
      modelsPollRef.current = setInterval(async () => {
        ticks++
        await fetchModels()
        if (ticks > 30) { stopModelsPoll(); setGenLibBusy(false) }
      }, 6000)
    } catch (e) { setError(e.message); setGenLibBusy(false) }
  }

  // 模特库满了就停生成态
  useEffect(() => {
    if (genLibBusy && profiles.length > 0 && models.length >= profiles.length) {
      stopModelsPoll(); setGenLibBusy(false)
    }
  }, [models, profiles, genLibBusy, stopModelsPoll])

  const chooseModel = async (modelId) => {
    setError(null)
    try {
      const r = await fetch(`${API}/workflow/${workflowId}/model`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, imageModel }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '选模特失败')
      startPoll(workflowId)  // 进入首帧生成，继续轮询
    } catch (e) { setError(e.message) }
  }

  const regenerateKeyframe = async (segIndex) => {
    setError(null)
    try {
      const r = await fetch(`${API}/workflow/${workflowId}/keyframes/regenerate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segmentIndex: segIndex, imagePrompt: kfPrompts[segIndex], imageModel }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '重生成失败')
      startPoll(workflowId)
    } catch (e) { setError(e.message) }
  }

  // 开启/重生成/关闭某段尾帧
  const setLastFrame = async (segIndex, enable) => {
    setError(null)
    try {
      const r = await fetch(`${API}/workflow/${workflowId}/keyframes/last`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segmentIndex: segIndex, enable, imagePrompt: lfPrompts[segIndex], imageModel }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '尾帧操作失败')
      startPoll(workflowId)
    } catch (e) { setError(e.message) }
  }

  const confirmKeyframes = async () => {
    setError(null)
    try {
      const r = await fetch(`${API}/workflow/${workflowId}/keyframes/confirm`, { method: 'POST' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '确认失败')
      setWf(d)
    } catch (e) { setError(e.message) }
  }

  const confirmPrompts = async () => {
    setError(null)
    const segments = Object.entries(vpPrompts).map(([index, videoPrompt]) => ({ index: Number(index), videoPrompt }))
    try {
      const r = await fetch(`${API}/workflow/${workflowId}/prompts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments, confirm: true }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '生成失败')
      startPoll(workflowId)
    } catch (e) { setError(e.message) }
  }

  // 自动托管：从当前步起 AI 跑完剩余流程
  const runAutopilot = async () => {
    setError(null)
    try {
      const r = await fetch(`${API}/workflow/${workflowId}/autopilot`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '托管失败')
      startPoll(workflowId)
    } catch (e) { setError(e.message) }
  }

  // AI 辅助：审核某段脚本/视频提示词
  const askAI = async (step, segIndex) => {
    const key = `${step}-${segIndex}`
    setAiBusy(p => ({ ...p, [key]: true })); setError(null)
    try {
      const r = await fetch(`${API}/workflow/${workflowId}/ai-assist`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step, segmentIndex: segIndex }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'AI 审核失败')
      setAiResults(p => ({ ...p, [key]: d }))
    } catch (e) { setError(e.message) } finally { setAiBusy(p => ({ ...p, [key]: false })) }
  }
  const adoptAI = (step, segIndex) => {
    const key = `${step}-${segIndex}`
    const res = aiResults[key]; if (!res) return
    if (step === 'script') setScripts(p => ({ ...p, [segIndex]: res.rewritten }))
    else setVpPrompts(p => ({ ...p, [segIndex]: res.rewritten }))
    setAiResults(p => { const n = { ...p }; delete n[key]; return n })
  }
  const renderAi = (step, idx) => {
    const key = `${step}-${idx}`
    const res = aiResults[key]
    return (
      <div style={{ marginTop: 4 }}>
        <button style={s.btnGhost} onClick={() => askAI(step, idx)} disabled={aiBusy[key]}>{aiBusy[key] ? 'AI 审核中…' : '🤖 AI 看看'}</button>
        {res && (
          <div style={{ marginTop: 6, padding: 8, background: res.ok ? '#f0fdf4' : '#fffbeb', border: `1px solid ${res.ok ? '#bbf7d0' : '#fde68a'}`, borderRadius: 6, fontSize: 12 }}>
            <div style={{ color: res.ok ? '#15803d' : '#b45309', fontWeight: 600 }}>{res.ok ? '✅ 没大问题' : '⚠️ 建议优化'}</div>
            {res.issues && <div style={{ color: '#92400e', marginTop: 2 }}>{res.issues}</div>}
            {res.suggestion && <div style={{ color: '#6b7280', marginTop: 2 }}>建议：{res.suggestion}</div>}
            <button style={{ ...s.btnGhost, marginTop: 6 }} onClick={() => adoptAI(step, idx)}>采纳改写</button>
          </div>
        )}
      </div>
    )
  }

  const reset = () => {
    stopPoll(); stopModelsPoll()
    setWorkflowId(null); setWf(null); setScripts({}); setKfPrompts({}); setError(null); setLoading(false)
  }

  const status = wf?.status
  const scriptsDone = wf && status !== 'analyzing' && status !== 'await_scripts'

  return (
    <div style={s.wrap}>
      {error && <div style={s.err}>⚠️ {error}</div>}

      {/* 模特库（常驻入口，预生成一次长期复用） */}
      <div style={s.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ ...s.cardTitle, marginBottom: 0 }}>🎭 模特库（{models.length}/{profiles.length}）</div>
          <button style={s.btnGhost} onClick={() => setShowLib(v => !v)}>{showLib ? '收起' : '展开'}</button>
        </div>
        {showLib && (
          <div style={{ marginTop: 12 }}>
            <div style={s.note}>预生成一次、长期复用的模特定妆照（美国市场画像，纯身份形象）。出视频时从这里挑或随机。生成会消耗图像额度，约几分钟。</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
              <label style={{ fontSize: 12, color: '#555' }}>图像模型</label>
              <select style={s.select} value={imageModel} onChange={e => setImageModel(e.target.value)}>
                {IMAGE_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <button style={s.btn} onClick={predefineLibrary} disabled={genLibBusy}>
                {genLibBusy ? `生成中…（${models.length}/${profiles.length}）` : (models.length > 0 ? '重新生成模特库' : '✨ 预生成模特库')}
              </button>
              <button style={s.btnGhost} onClick={fetchModels}>刷新</button>
            </div>
            {models.length > 0 && (
              <div style={s.gallery}>
                {models.map(m => (
                  <div key={m.id} style={s.modelCard(false)} title={m.presenter}>
                    <img src={m.imageUrl} alt={m.label} style={s.modelImg} />
                    <div style={{ fontSize: 11, marginTop: 4, color: '#374151' }}>{m.label}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {workflowId && ['await_scripts', 'await_model', 'await_keyframes', 'await_prompts'].includes(status) && (
        <div style={{ ...s.card, padding: 14, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, background: '#eef2ff', border: '1px solid #c7d2fe' }}>
          <span style={{ fontSize: 13, color: '#3730a3', fontWeight: 600 }}>🤖 想省事？</span>
          <button style={s.btn} onClick={runAutopilot}>从这步起自动托管，AI 跑完剩余流程</button>
          <span style={s.note}>（AI 自动确认/随机选模特/出图出片，中途不再停）</span>
        </div>
      )}
      {wf?.auto && ['generating_keyframes', 'generating_videos'].includes(status) && (
        <div style={{ ...s.note, marginBottom: 10, color: '#3730a3' }}>🤖 AI 托管中…</div>
      )}

      {/* ① 分析输入 */}
      {!workflowId && (
        <div style={s.card}>
          <div style={s.cardTitle}>① 分析参考视频 → 生成分段脚本</div>
          <div style={s.row}>
            <div style={s.field}>
              <label style={s.label}>参考视频文件</label>
              <input style={s.input} type="file" accept="video/*" onChange={e => setRefVideo(e.target.files?.[0] || null)} />
            </div>
            <div style={s.field}>
              <label style={s.label}>或 TikTok 链接</label>
              <input style={s.input} value={tiktokUrl} onChange={e => setTiktokUrl(e.target.value)} placeholder="https://www.tiktok.com/..." />
            </div>
          </div>
          <div style={s.field}>
            <label style={s.label}>选择产品</label>
            {products.length === 0 ? (
              <div style={s.note}>暂无产品。去 <strong>📦 产品管理</strong> tab 抓取后回来，或点 <span style={{ color: '#6366f1', cursor: 'pointer' }} onClick={fetchProducts}>刷新</span>。</div>
            ) : (
              <div style={s.gallery}>
                {products.map(p => {
                  const on = productInfo?.productId === p.productId
                  return (
                    <div key={p.productId} style={s.modelCard(on)} onClick={() => selectProduct(p.productId)} title={p.name}>
                      {p.coverImageUrl
                        ? <img src={p.coverImageUrl} alt="" style={s.modelImg} loading="lazy" />
                        : <div style={{ ...s.modelImg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, color: '#bbb' }}>📦</div>}
                      <div style={{ fontSize: 11, marginTop: 4, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name || '(未命名)'}</div>
                    </div>
                  )
                })}
              </div>
            )}
            {productInfo && <div style={{ ...s.note, color: '#15803d' }}>✅ 已选：{(productInfo.name || '').slice(0, 50)}（{loadingProduct ? '加载中…' : `${(productInfo.mainImageUrls?.length || 0) + (productInfo.detailImageUrls?.length || 0)} 张图`}）</div>}
            {productColorInventory && Object.keys(productColorInventory).length > 0 && (
              <div style={{ marginTop: 8 }}>
                <label style={s.label}>SKU 颜色（推荐只用同一 SKU，防止生成串色）</label>
                <select style={{ ...s.select, width: '100%' }} value={productSkuColor} onChange={e => setProductSkuColor(e.target.value)}>
                  <option value="">— 不过滤（用全部图）—</option>
                  {Object.entries(productColorInventory).map(([c, n]) => <option key={c} value={c}>{c}（{n} 张）</option>)}
                </select>
                {productSkuColor && productInfo && (
                  <div style={{ ...s.note, color: '#16a34a' }}>✓ {(productInfo.mainImageUrls?.length || 0) + (productInfo.detailImageUrls?.length || 0)} 张 {productSkuColor} 图将用于本次生成</div>
                )}
              </div>
            )}
          </div>
          <div style={s.field}>
            <label style={s.label}>补充说明（可选）</label>
            <textarea style={s.textarea} value={description} onChange={e => setDescription(e.target.value)} />
          </div>
          <div style={s.row}>
            <div style={s.field}>
              <label style={s.label}>品类</label>
              <select style={{ ...s.select, width: '100%' }} value={category} onChange={e => setCategory(e.target.value)}>
                {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div style={s.field}>
              <label style={s.label}>时长</label>
              <select style={{ ...s.select, width: '100%' }} value={duration} onChange={e => setDuration(e.target.value)}>
                <option value="auto">自动（按参考视频，≤30s）</option>
                {[8, 10, 15, 20, 25, 30].map(n => <option key={n} value={n}>{n}s</option>)}
              </select>
            </div>
            <div style={s.field}>
              <label style={s.label}>分辨率</label>
              <select style={{ ...s.select, width: '100%' }} value={resolution} onChange={e => setResolution(e.target.value)}>
                {['480p', '720p'].map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>
          <button style={s.btn} onClick={submit} disabled={loading}>{loading ? '分析中…' : '开始分析'}</button>
        </div>
      )}

      {workflowId && status === 'analyzing' && (
        <div style={s.card}>
          <div style={s.cardTitle}>分析中… <span style={s.pill('analyzing')}>{wf?.stepLabel || '处理中'}</span></div>
          <div style={s.note}>Gemini 正在分析参考视频并规划分镜脚本，请稍候。</div>
        </div>
      )}

      {/* ② 审核脚本 */}
      {wf?.segments?.length > 0 && (
        <div style={s.card}>
          <div style={s.cardTitle}>
            ② 分段脚本 <span style={s.pill(scriptsDone ? 'completed' : 'await_scripts')}>{scriptsDone ? '已确认' : '待确认'}</span>
            <span style={{ ...s.note, marginLeft: 10 }}>共 {wf.segments.length} 段 · 策略 {wf.planSummary?.strategy}</span>
          </div>
          {wf.segments.map(seg => (
            <div key={seg.index} style={s.segCard}>
              <div style={s.segHead}>
                <strong>第 {seg.index} 段</strong><span>· {seg.role}</span><span>· {seg.duration}s</span>
                {seg.focus && <span style={{ color: '#6366f1' }}>· 聚焦：{seg.focus}</span>}
              </div>
              <textarea style={s.textarea} value={scripts[seg.index] ?? ''} disabled={scriptsDone}
                onChange={e => setScripts(prev => ({ ...prev, [seg.index]: e.target.value }))} />
              {!scriptsDone && renderAi('script', seg.index)}
            </div>
          ))}
          {status === 'await_scripts' && (
            <button style={s.btn} onClick={confirmScripts} disabled={confirming}>{confirming ? '提交中…' : '确认脚本，继续 →'}</button>
          )}
          <button style={{ ...s.btnGhost, marginLeft: status === 'await_scripts' ? 10 : 0 }} onClick={reset}>重新开始</button>
        </div>
      )}

      {/* ③ 选模特 */}
      {status === 'await_model' && (
        <div style={s.card}>
          <div style={s.cardTitle}>③ 选择模特</div>
          <div style={s.row}>
            <div>
              <label style={s.label}>首帧图像模型</label>
              <select style={s.select} value={imageModel} onChange={e => setImageModel(e.target.value)}>
                {IMAGE_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
          </div>
          {models.length === 0 ? (
            <div style={{ marginTop: 12 }}>
              <div style={s.note}>模特库还是空的。预生成会用文生图生成 {profiles.length} 个美国市场画像（消耗图像额度，约几分钟）。</div>
              <button style={{ ...s.btn, marginTop: 8 }} onClick={predefineLibrary} disabled={genLibBusy}>
                {genLibBusy ? `生成中… (${models.length}/${profiles.length})` : '✨ 预生成模特库'}
              </button>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                <button style={s.btn} onClick={() => chooseModel('random')}>🎲 随机选一个</button>
                <button style={s.btnGhost} onClick={fetchModels}>刷新</button>
                <button style={s.btnGhost} onClick={predefineLibrary} disabled={genLibBusy}>
                  {genLibBusy ? `补生成中 (${models.length}/${profiles.length})` : '重新生成模特库'}
                </button>
              </div>
              <div style={s.gallery}>
                {models.map(m => (
                  <div key={m.id} style={s.modelCard(false)} onClick={() => chooseModel(m.id)} title={m.presenter}>
                    <img src={m.imageUrl} alt={m.label} style={s.modelImg} />
                    <div style={{ fontSize: 11, marginTop: 4, color: '#374151' }}>{m.label}</div>
                  </div>
                ))}
              </div>
            </>
          )}
          <button style={{ ...s.btnGhost, marginTop: 12 }} onClick={reset}>重新开始</button>
        </div>
      )}

      {/* ④ 首帧生成 / 审核 */}
      {(status === 'generating_keyframes' || status === 'await_keyframes') && (
        <div style={s.card}>
          <div style={s.cardTitle}>
            ④ 各段首帧 <span style={s.pill(status === 'await_keyframes' ? 'await_keyframes' : 'generating')}>
              {status === 'await_keyframes' ? '待审核' : '生成中…'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {wf.segments.map(seg => (
              <div key={seg.index} style={{ width: 240 }}>
                <div style={s.segHead}><strong>第 {seg.index} 段</strong><span>· {seg.role}</span></div>

                {/* 首帧 */}
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>首帧</div>
                {seg.keyframeUrl
                  ? <img src={seg.keyframeUrl} alt={`seg ${seg.index} first`} style={s.kfImg} />
                  : <div style={{ ...s.kfImg, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: 12 }}>
                      {seg.keyframeState === 'failed' ? '生成失败' : '生成中…'}
                    </div>}
                {status === 'await_keyframes' && (
                  <div style={{ marginTop: 6 }}>
                    <textarea style={{ ...s.textarea, minHeight: 48, fontSize: 12 }}
                      placeholder="改写首帧提示词（可选）后重生成"
                      value={kfPrompts[seg.index] ?? (seg.imagePrompt || '')}
                      onChange={e => setKfPrompts(prev => ({ ...prev, [seg.index]: e.target.value }))} />
                    <button style={{ ...s.btnGhost, marginTop: 4 }} onClick={() => regenerateKeyframe(seg.index)}>重生成首帧</button>
                  </div>
                )}

                {/* 尾帧（可选，默认关；before/after 这种 hook 用） */}
                {status === 'await_keyframes' && (
                  <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed #e5e7eb' }}>
                    {!seg.useLastFrame ? (
                      <button style={s.btnGhost} onClick={() => setLastFrame(seg.index, true)}>+ 定义尾帧（before/after 等）</button>
                    ) : (
                      <>
                        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>尾帧（收尾 / after 状态）</div>
                        {seg.lastFrameUrl
                          ? <img src={seg.lastFrameUrl} alt={`seg ${seg.index} last`} style={s.kfImg} />
                          : <div style={{ ...s.kfImg, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: 12 }}>
                              {seg.lastFrameState === 'failed' ? '生成失败' : '生成中…'}
                            </div>}
                        <textarea style={{ ...s.textarea, minHeight: 48, fontSize: 12, marginTop: 6 }}
                          placeholder="尾帧提示词（描述收尾 / after 画面）"
                          value={lfPrompts[seg.index] ?? (seg.lastFramePrompt || '')}
                          onChange={e => setLfPrompts(prev => ({ ...prev, [seg.index]: e.target.value }))} />
                        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                          <button style={s.btnGhost} onClick={() => setLastFrame(seg.index, true)}>重生成尾帧</button>
                          <button style={s.btnGhost} onClick={() => setLastFrame(seg.index, false)}>移除</button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          {status === 'await_keyframes' && (
            <button style={{ ...s.btn, marginTop: 14 }} onClick={confirmKeyframes}>确认首帧，继续 →</button>
          )}
          <button style={{ ...s.btnGhost, marginTop: 14, marginLeft: 10 }} onClick={reset}>重新开始</button>
        </div>
      )}

      {/* ⑤ 视频提示词审核 */}
      {status === 'await_prompts' && (
        <div style={s.card}>
          <div style={s.cardTitle}>⑤ 视频提示词审核 → 生成视频</div>
          <div style={s.note}>每段提示词可改；确认后各段用各自首帧（+尾帧）<strong>并行</strong>生成视频，再拼接成片。</div>
          {wf.segments.map(seg => (
            <div key={seg.index} style={s.segCard}>
              <div style={s.segHead}>
                <strong>第 {seg.index} 段</strong><span>· {seg.role}</span><span>· {seg.duration}s</span>
                {seg.useLastFrame && <span style={{ color: '#8b5cf6' }}>· 含尾帧</span>}
              </div>
              <textarea style={{ ...s.textarea, minHeight: 90, fontSize: 12 }}
                value={vpPrompts[seg.index] ?? (seg.videoPrompt || '')}
                onChange={e => setVpPrompts(prev => ({ ...prev, [seg.index]: e.target.value }))} />
              {renderAi('videoPrompt', seg.index)}
            </div>
          ))}
          <button style={{ ...s.btn, marginTop: 8 }} onClick={confirmPrompts}>确认，生成视频 →</button>
          <button style={{ ...s.btnGhost, marginTop: 8, marginLeft: 10 }} onClick={reset}>重新开始</button>
        </div>
      )}

      {/* ⑥ 生成视频中 */}
      {status === 'generating_videos' && (
        <div style={s.card}>
          <div style={s.cardTitle}>⑥ 生成视频中… <span style={s.pill('generating')}>各段并行</span></div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {wf.segments.map(seg => (
              <div key={seg.index} style={{ ...s.segCard, width: 150, textAlign: 'center' }}>
                <div style={s.segHead}><strong>第 {seg.index} 段</strong></div>
                <div style={{ fontSize: 12, color: seg.videoState === 'success' ? '#15803d' : seg.videoState === 'failed' ? '#b91c1c' : '#6366f1' }}>
                  {seg.videoState === 'success' ? '✅ 完成' : seg.videoState === 'failed' ? '❌ 失败' : '⏳ 生成中…'}
                </div>
              </div>
            ))}
          </div>
          <div style={s.note}>视频生成较慢（每段约 1-3 分钟），各段同时进行。</div>
        </div>
      )}

      {/* ⑦ 成片 */}
      {status === 'completed' && (
        <div style={s.card}>
          <div style={s.cardTitle}>✅ 成片 <span style={s.pill('completed')}>完成</span></div>
          {wf.finalVideoUrl
            ? <video src={wf.finalVideoUrl} controls style={{ width: 270, borderRadius: 10, background: '#000' }} />
            : <div style={s.note}>成片地址缺失</div>}
          {wf.finalVideoUrl && (
            <div style={{ marginTop: 10 }}>
              <a href={wf.finalVideoUrl} target="_blank" rel="noreferrer" style={{ color: '#6366f1', fontSize: 13 }}>下载 / 打开成片</a>
            </div>
          )}
          <button style={{ ...s.btnGhost, marginTop: 12 }} onClick={reset}>再做一条</button>
        </div>
      )}

      {status === 'failed' && (
        <div style={s.card}>
          <div style={s.cardTitle}>失败</div>
          <button style={s.btnGhost} onClick={reset}>重新开始</button>
        </div>
      )}
    </div>
  )
}
