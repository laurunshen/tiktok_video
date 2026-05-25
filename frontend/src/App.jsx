import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import ProductManager from './ProductManager.jsx'
import HistoryView from './HistoryView.jsx'
import AffiliateVideos from './AffiliateVideos.jsx'
import MyTemplates from './MyTemplates.jsx'
import BenchmarkAnalyzer from './BenchmarkAnalyzer.jsx'

const API = '/api'

const STEPS = [
  { label: '上传产品图到 kie.ai', icon: '📤' },
  { label: 'Gemini 分析视频 + 生成提示词', icon: '🧠' },
  { label: '创建 Seedance 生成任务', icon: '🎬' },
  { label: 'Seedance 生成中，请耐心等待…', icon: '⏳' },
]

const s = {
  root: { minHeight: '100vh', background: '#f5f5f7', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  wrap: { maxWidth: 820, margin: '0 auto', padding: '36px 20px 60px' },
  h1: { fontSize: 26, fontWeight: 700, margin: '0 0 4px', color: '#111' },
  sub: { fontSize: 14, color: '#888', marginBottom: 32 },
  card: { background: '#fff', borderRadius: 14, padding: 24, marginBottom: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.07)' },
  cardTitle: { fontSize: 14, fontWeight: 600, color: '#444', marginBottom: 14, textTransform: 'uppercase', letterSpacing: 0.4 },
  dz: (active) => ({
    border: `2px dashed ${active ? '#6366f1' : '#ddd'}`,
    borderRadius: 10, padding: '28px 20px', textAlign: 'center',
    cursor: 'pointer', background: active ? '#f0f0ff' : '#fafafa',
    transition: 'all 0.18s', color: '#999', fontSize: 14,
  }),
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px,1fr))', gap: 8, marginTop: 12 },
  thumb: { width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 7, border: '1px solid #eee', display: 'block' },
  badge: { position: 'absolute', top: 3, left: 3, background: 'rgba(99,102,241,0.85)', color: '#fff', fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 3 },
  rmBtn: { position: 'absolute', top: 3, right: 3, background: 'rgba(0,0,0,0.45)', color: '#fff', border: 'none', borderRadius: '50%', width: 18, height: 18, cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 },
  row: { display: 'flex', gap: 14, flexWrap: 'wrap' },
  field: { flex: 1, minWidth: 140 },
  label: { display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 5 },
  select: { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, background: '#fff', outline: 'none', cursor: 'pointer' },
  input: { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, outline: 'none', boxSizing: 'border-box' },
  textarea: { width: '100%', minHeight: 72, padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, resize: 'vertical', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  btnPrimary: (disabled) => ({ padding: '11px 28px', borderRadius: 9, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 15, fontWeight: 600, background: disabled ? '#c7c7c7' : '#6366f1', color: '#fff', transition: 'background 0.15s' }),
  btnGhost: { padding: '11px 20px', borderRadius: 9, border: '1px solid #ddd', background: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 500, color: '#555' },
  stepRow: (done, active) => ({ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid #f3f3f3', color: done ? '#16a34a' : active ? '#6366f1' : '#bbb', fontSize: 14 }),
  dot: (done, active) => ({ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, background: done ? '#16a34a' : active ? '#e0e7ff' : '#f0f0f0', color: done ? '#fff' : active ? '#6366f1' : '#bbb' }),
  pill: (s) => ({ display: 'inline-block', padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: s === 'completed' ? '#dcfce7' : s === 'failed' ? '#fee2e2' : '#dbeafe', color: s === 'completed' ? '#15803d' : s === 'failed' ? '#b91c1c' : '#1d4ed8' }),
  promptBox: { background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 14, fontSize: 13, lineHeight: 1.65, whiteSpace: 'pre-wrap', color: '#334155', maxHeight: 220, overflowY: 'auto', marginTop: 6 },
  tag: { display: 'inline-block', background: '#ede9fe', color: '#6d28d9', padding: '2px 8px', borderRadius: 4, fontSize: 12, margin: '2px' },
  videoWrap: { background: '#f9fafb', borderRadius: 10, padding: 14, marginTop: 10 },
  video: { width: '100%', borderRadius: 8, maxHeight: 420, display: 'block' },
  err: { background: '#fff1f2', border: '1px solid #fecdd3', borderRadius: 9, padding: 14, color: '#be123c', fontSize: 14, marginBottom: 16 },
  copyBtn: { padding: '5px 12px', borderRadius: 6, border: '1px solid #ddd', background: '#fff', cursor: 'pointer', fontSize: 12, color: '#555', marginTop: 8 },
  prodPick: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10,
  },
  prodCard: (active) => ({
    border: `2px solid ${active ? '#6366f1' : '#eee'}`,
    borderRadius: 10, padding: 8, cursor: 'pointer',
    background: active ? '#eef2ff' : '#fff',
    transition: 'all 0.15s', position: 'relative',
  }),
  prodCardCover: { width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 6, background: '#f5f5f5', display: 'block' },
  prodCardName: { fontSize: 12, fontWeight: 600, color: '#111', marginTop: 6, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' },
  prodCardMeta: { fontSize: 10, color: '#888', marginTop: 4 },
  tabBar: { display: 'flex', gap: 4, marginBottom: 24, borderBottom: '1px solid #e5e5e5' },
  tabBtn: (active) => ({
    padding: '10px 18px', border: 'none', background: 'none', cursor: 'pointer',
    fontSize: 14, fontWeight: active ? 600 : 500,
    color: active ? '#6366f1' : '#666',
    borderBottom: `2px solid ${active ? '#6366f1' : 'transparent'}`,
    marginBottom: -1, transition: 'all 0.15s',
  }),
}

function DropZone({ label, accept, multiple, onFiles, files, type }) {
  const [drag, setDrag] = useState(false)
  const ref = useRef()
  const handle = (rawFiles) => {
    const filtered = Array.from(rawFiles).filter(f =>
      type === 'video' ? f.type.startsWith('video/') : f.type.startsWith('image/')
    )
    if (filtered.length) onFiles(multiple ? filtered : [filtered[0]])
  }
  return (
    <div style={s.dz(drag)}
      onDragOver={e => { e.preventDefault(); setDrag(true) }}
      onDragLeave={() => setDrag(false)}
      onDrop={e => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files) }}
      onClick={() => ref.current.click()}>
      <input ref={ref} type="file" accept={accept} multiple={multiple} style={{ display: 'none' }}
        onChange={e => handle(e.target.files)} />
      <div style={{ fontSize: 30, marginBottom: 6 }}>{type === 'video' ? '🎬' : '🖼️'}</div>
      {files?.length > 0
        ? <div style={{ color: '#6366f1', fontWeight: 600 }}>{files.length} 个文件已选择</div>
        : <div><strong style={{ color: '#555' }}>{label}</strong><br /><span style={{ fontSize: 12 }}>点击或拖拽上传</span></div>}
    </div>
  )
}

const CATEGORIES = [
  { value: 'lingerie', label: '👙 内衣 / 塑形' },
  { value: 'general', label: '📦 通用品类' },
]

const REGIONS = ['SG', 'US', 'GB', 'MY', 'TH', 'PH', 'VN', 'ID', 'AU']

export default function App() {
  const [tab, setTab] = useState('generate')  // 'generate' | 'products' | 'history' | 'affiliate'
  const [cachedProducts, setCachedProducts] = useState([])
  // 选中缓存产品后的颜色过滤
  const [productSkuColor, setProductSkuColor] = useState('')  // '' = 不过滤；其他 = 只用该颜色的图
  const [productColorInventory, setProductColorInventory] = useState(null)  // { color: count } 来自后端 getProductFull
  const [productAllImages, setProductAllImages] = useState(null)  // { main:[{url,color}], detail:[...], user:[...] } 全量原始
  const [productSkuRecommendation, setProductSkuRecommendation] = useState(null)  // { recommended, reason } AI 推荐
  const [refVideo, setRefVideo] = useState([])
  const [tiktokVideoUrl, setTiktokVideoUrl] = useState('')
  const [images, setImages] = useState([])
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('lingerie')
  const [productUrl, setProductUrl] = useState('')
  const [productRegion, setProductRegion] = useState('US')
  const [productInfo, setProductInfo] = useState(null)
  const [productId, setProductId] = useState(null)
  const [fetchingProduct, setFetchingProduct] = useState(false)
  const [productError, setProductError] = useState(null)
  const [isSameProduct, setIsSameProduct] = useState(true)
  // 标杆参考视频库
  const [benchmarkVideos, setBenchmarkVideos] = useState([])
  const [showBenchmarks, setShowBenchmarks] = useState(false)
  const [loadingBenchmarks, setLoadingBenchmarks] = useState(false)
  const [batchCount, setBatchCount] = useState(1)
  const [resolution, setResolution] = useState('480p')
  const [duration, setDuration] = useState(15)
  const [generationMode, setGenerationMode] = useState('single_pass')  // 'single_pass' | 'agentic_segments'
  // VARIANT: 同一标杆视频的裂变配方（不同模特+场景），null=不指定
  const [variantSeed, setVariantSeed] = useState(null)
  const [variants, setVariants] = useState([])
  const [skipReferenceVideo, setSkipReferenceVideo] = useState(false)  // A/B 测试：跳过 Seedance reference_video
  const [beforeAfterMode, setBeforeAfterMode] = useState(false)  // before-after 模板模式（独立支路，不影响普通任务）
  // before-after 概念助手状态
  const [baSellingPoints, setBaSellingPoints] = useState([])
  const [baSelectedSP, setBaSelectedSP] = useState([])
  const [baConcepts, setBaConcepts] = useState([])
  const [baLoadingSP, setBaLoadingSP] = useState(false)
  const [baLoadingConcepts, setBaLoadingConcepts] = useState(false)
  const [baError, setBaError] = useState('')
  const [baUserIdea, setBaUserIdea] = useState('')  // 用户自己的 before/after 方向（可选）
  const [jobId, setJobId] = useState(null)
  const [jobStatus, setJobStatus] = useState(null)
  const [loading, setLoading] = useState(false)
  const [currentStep, setCurrentStep] = useState(-1)
  const [error, setError] = useState(null)
  const [waitSec, setWaitSec] = useState(0)
  const [subStepStart, setSubStepStart] = useState(null)  // 当前 stepLabel 开始的时间戳
  const [subStepLabel, setSubStepLabel] = useState('')  // 上次记录的 stepLabel
  const [now, setNow] = useState(Date.now())
  const [copied, setCopied] = useState(false)
  const pollRef = useRef(null)
  const timerRef = useRef(null)

  // 用 useMemo 缓存预览 URL，避免每次渲染重新生成
  const imagePreviews = useMemo(() =>
    images.map(f => URL.createObjectURL(f)),
    [images]
  )
  // 清理 object URL 防止内存泄漏
  useEffect(() => {
    return () => imagePreviews.forEach(url => URL.revokeObjectURL(url))
  }, [imagePreviews])

  // 启动时拉取 variant 配方列表（用于"同一标杆裂变出 5 种不同视频"）
  useEffect(() => {
    fetch(`${API}/generate/variants`)
      .then(r => r.json())
      .then(d => setVariants(d.variants || []))
      .catch(() => {})
  }, [])

  // stepLabel 变化时重置 subStep 计时
  useEffect(() => {
    const lbl = jobStatus?.stepLabel || ''
    if (lbl !== subStepLabel) {
      setSubStepLabel(lbl)
      setSubStepStart(Date.now())
    }
  }, [jobStatus?.stepLabel, subStepLabel])

  // 1s tick — 让 elapsed 显示是活的
  useEffect(() => {
    if (!loading) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [loading])

  // 切到生成页时刷新缓存产品列表（用于下拉选择器）
  useEffect(() => {
    if (tab !== 'generate') return
    fetch(`${API}/product/list`)
      .then(r => r.json())
      .then(d => setCachedProducts(d.items || []))
      .catch(() => {})
  }, [tab])

  // 选缓存产品 → 自动填充 productInfo，跳过爬虫
  const selectCachedProduct = async (productId) => {
    if (!productId) {
      setProductColorInventory(null); setProductAllImages(null); setProductSkuColor(''); setProductSkuRecommendation(null)
      return
    }
    setProductSkuRecommendation(null)
    setFetchingProduct(true)
    setProductError(null)
    try {
      const r = await fetch(`${API}/product/cache/${productId}`)
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || '加载缓存失败')
      const p = data.product
      // 全量原始数据（含颜色对齐数组），后续按颜色过滤
      const rawImages = {
        main: (p.mainImageUrls || []).map((u, i) => ({ url: u, color: (p.mainImageColors || [])[i] || '' })),
        detail: (p.detailImageUrls || []).map((u, i) => ({ url: u, color: (p.detailImageColors || [])[i] || '' })),
        user: (p.userImageUrls || []).map((u, i) => ({ url: u, color: (p.userImageColors || [])[i] || '' })),
      }
      // 颜色清单（排除未标）
      const inv = {}
      for (const arr of [rawImages.main, rawImages.detail, rawImages.user]) {
        for (const { color } of arr) {
          const k = (color || '').trim()
          if (k) inv[k] = (inv[k] || 0) + 1
        }
      }
      setProductAllImages(rawImages)
      setProductColorInventory(inv)
      setProductSkuColor('')  // 默认不过滤
      // 默认 productInfo = 全图（用户图并入 detail，与后端一致）
      const productInfo = {
        ...p.productInfo,
        productId: p.productId,
        mainImageUrls: p.mainImageUrls,
        detailImageUrls: [...p.detailImageUrls, ...p.userImageUrls],
      }
      setProductInfo(productInfo)
      setProductId(p.productId)
      setProductUrl(p.productId)
      setProductRegion(p.region || 'US')
      // 预取标杆视频
      setBenchmarkVideos([])
      setShowBenchmarks(false)
      try {
        const bm = await fetch(`${API}/product/benchmark-videos?productId=${p.productId}&limit=10`)
        if (bm.ok) {
          const bmd = await bm.json()
          if (bmd.videos?.length > 0) setBenchmarkVideos(bmd.videos)
        }
      } catch {}
    } catch (e) {
      setProductError(e.message)
    } finally {
      setFetchingProduct(false)
    }
  }

  // 颜色过滤变化 → 重算 productInfo 里的 url 数组
  useEffect(() => {
    if (!productAllImages || !productInfo) return
    const norm = (c) => (c || '').trim().toLowerCase()
    const target = norm(productSkuColor)
    if (!target) {
      // 不过滤：用全图
      setProductInfo(pi => ({
        ...pi,
        mainImageUrls: productAllImages.main.map(x => x.url),
        detailImageUrls: [...productAllImages.detail.map(x => x.url), ...productAllImages.user.map(x => x.url)],
      }))
    } else {
      const filterFn = (arr) => arr.filter(x => norm(x.color) === target).map(x => x.url)
      setProductInfo(pi => ({
        ...pi,
        mainImageUrls: filterFn(productAllImages.main),
        detailImageUrls: [...filterFn(productAllImages.detail), ...filterFn(productAllImages.user)],
      }))
    }
  // 只有当 sku color 或基础图集变化时才重算
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productSkuColor, productAllImages])

  const stopTimers = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }, [])

  const startPolling = useCallback((id) => {
    stopTimers()
    setWaitSec(0)
    timerRef.current = setInterval(() => setWaitSec(s => s + 1), 1000)

    const doPoll = async () => {
      try {
        const res = await fetch(`${API}/generate/status/${id}`)
        const data = await res.json()
        setJobStatus(data)
        // 直接用后端返回的 step 驱动进度条
        if (data.status === 'completed') {
          stopTimers()
          setLoading(false)
          setCurrentStep(STEPS.length) // 全部完成
        } else if (data.status === 'failed') {
          stopTimers()
          setLoading(false)
          setCurrentStep(-1)
        } else {
          setCurrentStep(data.step ?? 0)
        }
      } catch (e) { console.error('Poll error:', e) }
    }

    // 立即查一次
    doPoll()
    // pipeline 阶段 5s 一次，Seedance 生成阶段 15s 一次
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API}/generate/status/${id}`)
        const data = await res.json()
        setJobStatus(data)
        if (data.status === 'completed') {
          stopTimers()
          setLoading(false)
          setCurrentStep(STEPS.length)
        } else if (data.status === 'failed') {
          stopTimers()
          setLoading(false)
          setCurrentStep(-1)
        } else {
          setCurrentStep(data.step ?? 0)
          // step=3（Seedance生成中）时降低轮询频率
          if (data.step === 3) {
            clearInterval(pollRef.current)
            pollRef.current = setInterval(async () => {
              const r = await fetch(`${API}/generate/status/${id}`)
              const d = await r.json()
              setJobStatus(d)
              if (d.status === 'completed' || d.status === 'failed') {
                stopTimers()
                setLoading(false)
                setCurrentStep(d.status === 'completed' ? STEPS.length : -1)
              }
            }, 15000)
          }
        }
      } catch (e) { console.error('Poll error:', e) }
    }, 5000)
  }, [stopTimers])

  useEffect(() => () => stopTimers(), [stopTimers])

  const handleSubmit = async () => {
    // 视频：本地上传 或 TikTok 链接，二选一即可
    const hasVideo = refVideo[0] || tiktokVideoUrl.trim()
    // 产品图：本地上传 或 商品链接抓取，二选一即可
    const hasProductImages = images.length > 0 || (productInfo && (productInfo.mainImageUrls?.length > 0 || productInfo.detailImageUrls?.length > 0))

    if (!hasVideo) {
      setError('请提供参考视频（上传文件或填写 TikTok 链接）')
      return
    }
    if (!hasProductImages) {
      setError('请先在「选择产品」里选一个产品（没产品的话去 📦 产品管理 tab 抓取）')
      return
    }
    setError(null); setLoading(true); setJobStatus(null); setCurrentStep(0)
    const fd = new FormData()
    if (refVideo[0]) fd.append('referenceVideo', refVideo[0])
    images.forEach(img => fd.append('productImages', img))
    if (tiktokVideoUrl) fd.append('tiktokVideoUrl', tiktokVideoUrl)
    fd.append('userDescription', description)
    fd.append('category', category)
    if (productInfo) fd.append('productInfo', JSON.stringify(productInfo))
    fd.append('isSameProduct', isSameProduct ? '1' : '0')
    fd.append('batchCount', generationMode === 'agentic_segments' ? 1 : batchCount)
    fd.append('generationMode', generationMode)
    if (variantSeed) fd.append('variantSeed', variantSeed)
    if (skipReferenceVideo) fd.append('skipReferenceVideo', '1')
    if (beforeAfterMode) fd.append('mode', 'before-after')
    fd.append('resolution', resolution)
    fd.append('duration', duration)
    try {
      const res = await fetch(`${API}/generate`, { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '服务器错误')
      setJobId(data.jobId)
      setCurrentStep(0)
      startPolling(data.jobId)
    } catch (e) {
      setError(e.message); setLoading(false); setCurrentStep(-1)
    }
  }

  const fetchProduct = async () => {
    if (!productUrl.trim()) return
    setFetchingProduct(true)
    setProductError(null)
    setProductInfo(null)
    try {
      const res = await fetch(`${API}/product/fetch?url=${encodeURIComponent(productUrl)}&region=${productRegion}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '抓取失败')
      setProductInfo(data.productInfo)
      setProductId(data.productId)
      // 自动预取标杆视频（如果该产品有数据）
      setBenchmarkVideos([])
      setShowBenchmarks(false)
      try {
        const bmRes = await fetch(`${API}/product/benchmark-videos?productId=${data.productId}&limit=10`)
        if (bmRes.ok) {
          const bmData = await bmRes.json()
          if (bmData.videos?.length > 0) setBenchmarkVideos(bmData.videos)
        }
      } catch {}
    } catch (e) {
      setProductError(e.message)
    } finally {
      setFetchingProduct(false)
    }
  }

  const reset = () => {
    stopTimers()
    setRefVideo([]); setImages([]); setDescription('')
    setTiktokVideoUrl('')
    setProductUrl(''); setProductInfo(null); setProductId(null); setProductError(null); setIsSameProduct(true)
    setProductSkuColor(''); setProductColorInventory(null); setProductAllImages(null)
    setBenchmarkVideos([]); setShowBenchmarks(false)
    setGenerationMode('single_pass')
    setVariantSeed(null)
    setJobId(null); setJobStatus(null); setLoading(false)
    setCurrentStep(-1); setError(null); setWaitSec(0); setCategory('lingerie')
  }

  // 只清视频和结果，保留产品/SKU/设置
  const resetVideoOnly = () => {
    stopTimers()
    setRefVideo([])
    setTiktokVideoUrl('')
    setJobId(null); setJobStatus(null); setLoading(false)
    setCurrentStep(-1); setError(null); setWaitSec(0)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const copyPrompt = () => {
    navigator.clipboard.writeText(jobStatus.prompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // === before-after 概念助手 ===
  const fetchSellingPoints = async () => {
    if (!productInfo) { setBaError('请先选择商品'); return }
    setBaLoadingSP(true); setBaError(''); setBaConcepts([]); setBaSelectedSP([])
    try {
      const r = await fetch(`${API}/before-after/selling-points`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productInfo }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '识别卖点失败')
      setBaSellingPoints(d.sellingPoints || [])
    } catch (e) { setBaError(e.message) } finally { setBaLoadingSP(false) }
  }

  const toggleSellingPoint = (id) => {
    setBaSelectedSP(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const fetchConcepts = async () => {
    const chosen = baSellingPoints.filter(sp => baSelectedSP.includes(sp.id))
    if (chosen.length === 0) { setBaError('请先勾选至少一个卖点'); return }
    setBaLoadingConcepts(true); setBaError('')
    try {
      const r = await fetch(`${API}/before-after/concepts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productInfo, sellingPoints: chosen, userIdea: baUserIdea }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '生成概念失败')
      setBaConcepts(d.concepts || [])
    } catch (e) { setBaError(e.message) } finally { setBaLoadingConcepts(false) }
  }

  const applyConcept = (concept) => {
    setDescription(concept.supplement)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleRetryKie = async () => {
    setError(null)
    setLoading(true)
    setCurrentStep(3)
    setJobStatus(prev => prev ? { ...prev, status: 'pending', error: null, tasks: [], videos: [] } : prev)
    try {
      const res = await fetch(`${API}/generate/retry-kie/${jobId}`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '重试失败')
      startPolling(jobId)
    } catch (e) {
      setError(e.message)
      setLoading(false)
      setCurrentStep(-1)
    }
  }

  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  const taskState = jobStatus?.tasks?.[0]?.state

  return (
    <div style={s.root}>
      <div style={s.wrap}>
        <h1 style={s.h1}>🎬 AI 带货视频生成器</h1>
        <p style={s.sub}>选产品 + 参考视频 → AI 自动分析风格并生成视频</p>

        <div style={s.tabBar}>
          <button style={s.tabBtn(tab === 'benchmark')} onClick={() => setTab('benchmark')}>标杆分析</button>
          <button style={s.tabBtn(tab === 'generate')} onClick={() => setTab('generate')}>🎬 生成视频</button>
          <button style={s.tabBtn(tab === 'products')} onClick={() => setTab('products')}>📦 产品管理</button>
          <button style={s.tabBtn(tab === 'history')} onClick={() => setTab('history')}>📜 历史</button>
          <button style={s.tabBtn(tab === 'affiliate')} onClick={() => setTab('affiliate')}>📊 达人视频库</button>
          <button style={s.tabBtn(tab === 'templates')} onClick={() => setTab('templates')}>⭐ 模板库</button>
        </div>

        <div style={{ display: tab === 'products' ? '' : 'none' }}><ProductManager /></div>
        <div style={{ display: tab === 'history' ? '' : 'none' }}><HistoryView /></div>
        <div style={{ display: tab === 'affiliate' ? '' : 'none' }}>
          <AffiliateVideos
            onUseVideo={url => {
              setTiktokVideoUrl(url)
              setRefVideo([])
              setJobId(null); setJobStatus(null); setLoading(false)
              setCurrentStep(-1); setError(null); setWaitSec(0)
              setTab('generate')
              window.scrollTo({ top: 0, behavior: 'smooth' })
            }}
          />
        </div>
        <div style={{ display: tab === 'templates' ? '' : 'none' }}>
          <MyTemplates
            onUseVideo={url => {
              setTiktokVideoUrl(url)
              setRefVideo([])
              setJobId(null); setJobStatus(null); setLoading(false)
              setCurrentStep(-1); setError(null); setWaitSec(0)
              setTab('generate')
              window.scrollTo({ top: 0, behavior: 'smooth' })
            }}
          />
        </div>

        <div style={{ display: tab === 'benchmark' ? '' : 'none' }}><BenchmarkAnalyzer /></div>

        {tab === 'generate' && (
        <>

        {/* 选择产品 */}
        <div style={s.card}>
          <div style={s.cardTitle}>选择产品</div>
          {cachedProducts.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#888', fontSize: 13 }}>
              暂无产品。<br />去 <strong>📦 产品管理</strong> tab 贴 TikTok Shop 链接抓取，再回来这里。
            </div>
          ) : (
            <div style={s.prodPick}>
              {cachedProducts.map(p => {
                const active = productInfo?.productId === p.productId
                return (
                  <div key={p.productId} style={s.prodCard(active)} onClick={() => selectCachedProduct(p.productId)}>
                    {p.coverImageUrl
                      ? <img src={p.coverImageUrl} alt="" style={s.prodCardCover} loading="lazy" />
                      : <div style={{ ...s.prodCardCover, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, color: '#bbb' }}>📦</div>}
                    <div style={s.prodCardName}>{p.name || '(未命名)'}</div>
                    <div style={s.prodCardMeta}>
                      {p.region} · 图 {p.mainImageCount + p.detailImageCount + p.userImageCount}
                      {p.userImageCount > 0 && ` (+${p.userImageCount} 自定义)`}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {productInfo && (
            <div style={{ marginTop: 14, padding: 12, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, fontSize: 13 }}>
              <div style={{ fontWeight: 600, color: '#15803d', marginBottom: 4 }}>✅ 已选：{productInfo.name?.slice(0, 60)}</div>
              <div style={{ color: '#166534', fontSize: 12 }}>id: {productInfo.productId}</div>
            </div>
          )}
          {productColorInventory && Object.keys(productColorInventory).length > 0 && (
            <div style={{ marginTop: 12 }}>
              <label style={s.label}>SKU 变体（强烈推荐：只用同一 SKU 的图防止生成串色）</label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <select style={{ ...s.select, flex: 1 }} value={productSkuColor}
                  onChange={e => setProductSkuColor(e.target.value)}>
                  <option value="">— 不过滤（用全部图）—</option>
                  {Object.entries(productColorInventory).map(([c, n]) => (
                    <option key={c} value={c}>{c} （{n} 张）</option>
                  ))}
                </select>
                <button style={{ ...s.btnGhost, padding: '8px 12px', fontSize: 12, whiteSpace: 'nowrap' }}
                  disabled={!productInfo?.productId}
                  onClick={async () => {
                    if (!productInfo?.productId) return
                    setProductSkuRecommendation({ loading: true })
                    try {
                      const r = await fetch(`${API}/product/${productInfo.productId}/recommend-sku`)
                      const data = await r.json()
                      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
                      setProductSkuRecommendation(data)
                    } catch (e) {
                      setProductSkuRecommendation({ error: e.message })
                    }
                  }}>
                  🌟 AI 推荐
                </button>
              </div>
              {productSkuRecommendation && (
                <div style={{ marginTop: 6, padding: '8px 10px', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 6, fontSize: 12 }}>
                  {productSkuRecommendation.loading && <span>评估中…</span>}
                  {productSkuRecommendation.error && <span style={{ color: '#b91c1c' }}>失败：{productSkuRecommendation.error}</span>}
                  {productSkuRecommendation.recommended && (
                    <>
                      <strong>推荐：{productSkuRecommendation.recommended}</strong>
                      {productSkuRecommendation.counts?.[productSkuRecommendation.recommended] && (
                        <span> （{productSkuRecommendation.counts[productSkuRecommendation.recommended]} 张图）</span>
                      )}
                      <button style={{ ...s.btnGhost, marginLeft: 8, padding: '2px 8px', fontSize: 11 }}
                        onClick={() => setProductSkuColor(productSkuRecommendation.recommended)}>
                        应用
                      </button>
                      <div style={{ marginTop: 4, color: '#78350f' }}>{productSkuRecommendation.reason}</div>
                    </>
                  )}
                  {!productSkuRecommendation.loading && !productSkuRecommendation.error && !productSkuRecommendation.recommended && (
                    <span>{productSkuRecommendation.reason || '无法推荐'}</span>
                  )}
                </div>
              )}
              {productSkuColor && productInfo && (
                (() => {
                  const total = (productInfo.mainImageUrls?.length || 0) + (productInfo.detailImageUrls?.length || 0)
                  if (total === 0) {
                    return <div style={{ marginTop: 6, fontSize: 12, color: '#be123c' }}>⚠️ 没有符合该 SKU 的图，生成按钮已禁用。请去产品管理打标或选其他 SKU。</div>
                  }
                  return <div style={{ marginTop: 6, fontSize: 12, color: '#16a34a' }}>✓ {total} 张 {productSkuColor} 图将用于本次生成</div>
                })()
              )}
            </div>
          )}
          {productColorInventory && Object.keys(productColorInventory).length === 0 && productAllImages && (
            <div style={{ marginTop: 12, padding: 10, background: '#fef3c7', borderRadius: 6, fontSize: 12, color: '#92400e' }}>
              ⚠️ 该产品所有图都未标颜色。建议先去 📦 产品管理 → 🪄 AI 一键识别颜色，再回来选 SKU 颜色防止生成串色。
            </div>
          )}
        </div>

        {/* 参考视频 */}
        <div style={s.card}>
          <div style={s.cardTitle}>参考视频</div>
          {!tiktokVideoUrl && (
            <>
              <DropZone label="上传参考带货视频" accept="video/*" multiple={false} type="video"
                files={refVideo} onFiles={setRefVideo} />
              {refVideo[0] && (
                <div style={{ marginTop: 10, fontSize: 13, color: '#16a34a' }}>
                  ✅ {refVideo[0].name}（{(refVideo[0].size / 1024 / 1024).toFixed(1)} MB）
                </div>
              )}
            </>
          )}
          {!refVideo[0] && (
            <div style={{ marginTop: tiktokVideoUrl ? 0 : 12 }}>
              <div style={{ fontSize: 12, color: '#aaa', marginBottom: 6, textAlign: tiktokVideoUrl ? 'left' : 'center' }}>
                {!tiktokVideoUrl && '— 或者 —'}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  style={{ ...s.input, flex: 1 }}
                  placeholder="粘贴 TikTok 视频链接（自动解析无水印直链）"
                  value={tiktokVideoUrl}
                  onChange={e => setTiktokVideoUrl(e.target.value)}
                />
                {tiktokVideoUrl && (
                  <button style={{ ...s.btnGhost, padding: '8px 12px', fontSize: 12, flexShrink: 0 }}
                    onClick={() => setTiktokVideoUrl('')}>清除</button>
                )}
              </div>
              {tiktokVideoUrl && (
                <div style={{ marginTop: 6, fontSize: 12, color: '#6366f1' }}>
                  ✅ 将在生成时自动解析无水印链接
                </div>
              )}
            </div>
          )}
          <div style={{ marginTop: 14, padding: 12, background: beforeAfterMode ? '#ede9fe' : '#f9fafb', borderRadius: 8, border: '1px solid', borderColor: beforeAfterMode ? '#8b5cf6' : '#e5e7eb' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#1f2937' }}>
              <input
                type="checkbox"
                checked={beforeAfterMode}
                onChange={e => setBeforeAfterMode(e.target.checked)}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
              🎬 Before-After 模板模式
            </label>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6, marginLeft: 24 }}>
              前 2 秒强制做 LOOK A / LOOK B 每半秒快切的 hook，后段按选中卖点递进讲解。台词由卖点生成，参考视频只贡献语气/节奏/运镜风格——配任意高转化带货视频即可，不必是 before-after 结构。普通任务不受影响。
            </div>

            {beforeAfterMode && (
              <div style={{ marginTop: 12, marginLeft: 24, paddingTop: 12, borderTop: '1px dashed #c4b5fd' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#6d28d9', marginBottom: 8 }}>✨ before/after 概念助手</div>

                <button
                  onClick={fetchSellingPoints}
                  disabled={baLoadingSP || !productInfo}
                  style={{ padding: '6px 12px', fontSize: 12, borderRadius: 6, border: '1px solid #8b5cf6',
                    background: '#fff', color: '#6d28d9', cursor: (baLoadingSP || !productInfo) ? 'not-allowed' : 'pointer', opacity: (baLoadingSP || !productInfo) ? 0.6 : 1 }}>
                  {baLoadingSP ? '识别中…' : '① AI 识别商品卖点'}
                </button>
                {!productInfo && <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 8 }}>先选商品</span>}

                {baSellingPoints.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>勾选要做 before/after 的卖点（可多选）：</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {baSellingPoints.map(sp => {
                        const on = baSelectedSP.includes(sp.id)
                        return (
                          <div key={sp.id} onClick={() => toggleSellingPoint(sp.id)}
                            title={sp.detail}
                            style={{ padding: '6px 10px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
                              border: '1.5px solid', borderColor: on ? '#8b5cf6' : '#e5e7eb',
                              background: on ? '#ede9fe' : '#fff', color: on ? '#6d28d9' : '#374151',
                              fontWeight: on ? 600 : 400 }}>
                            {on ? '✓ ' : ''}{sp.title}
                          </div>
                        )
                      })}
                    </div>
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>
                        我的想法 / 方向（可选 —— 填了 AI 就只围绕这个角度生成）：
                      </div>
                      <textarea
                        value={baUserIdea}
                        onChange={e => setBaUserIdea(e.target.value)}
                        placeholder="例：深V设计适合穿低胸V领衣服。Before 是普通bra边缘从V领口露出来，After 是这款plunge bra刚好藏住、领口干净。"
                        rows={3}
                        style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, padding: 8,
                          borderRadius: 6, border: '1px solid #ddd6fe', resize: 'vertical' }}
                      />
                    </div>
                    <button
                      onClick={fetchConcepts}
                      disabled={baLoadingConcepts || baSelectedSP.length === 0}
                      style={{ marginTop: 10, padding: '6px 12px', fontSize: 12, borderRadius: 6,
                        border: '1px solid #8b5cf6', background: baSelectedSP.length === 0 ? '#f3f4f6' : '#8b5cf6',
                        color: baSelectedSP.length === 0 ? '#9ca3af' : '#fff',
                        cursor: (baLoadingConcepts || baSelectedSP.length === 0) ? 'not-allowed' : 'pointer' }}>
                      {baLoadingConcepts ? '生成中…' : '② 根据选中卖点生成 3 个概念'}
                    </button>
                  </div>
                )}

                {baConcepts.length > 0 && (
                  <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {baConcepts.map((c, i) => (
                      <div key={c.id} style={{ padding: 10, borderRadius: 8, border: '1px solid #ddd6fe', background: '#faf5ff' }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#6d28d9', marginBottom: 4 }}>概念 {i + 1}：{c.hook}</div>
                        <div style={{ fontSize: 11, color: '#374151', lineHeight: 1.6 }}>
                          <div><b>Before：</b>{c.before}</div>
                          <div><b>After：</b>{c.after}</div>
                          <div style={{ marginTop: 4, color: '#6b7280' }}><b>补充说明：</b>{c.supplement}</div>
                        </div>
                        <button
                          onClick={() => applyConcept(c)}
                          style={{ marginTop: 8, padding: '5px 12px', fontSize: 12, borderRadius: 6,
                            border: 'none', background: '#8b5cf6', color: '#fff', cursor: 'pointer' }}>
                          用这个 → 填入补充说明
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {baError && <div style={{ marginTop: 8, fontSize: 11, color: '#dc2626' }}>⚠️ {baError}</div>}
              </div>
            )}
          </div>

          <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13, color: '#555' }}>参考视频是否为本产品的带货视频？</span>
            <div style={{ display: 'flex', gap: 0, borderRadius: 7, overflow: 'hidden', border: '1px solid #ddd' }}>
              {[{ v: true, label: '是' }, { v: false, label: '否' }].map(({ v, label }) => (
                <button key={label}
                  onClick={() => setIsSameProduct(v)}
                  style={{
                    padding: '5px 16px', fontSize: 13, border: 'none', cursor: 'pointer',
                    background: isSameProduct === v ? '#6366f1' : '#fff',
                    color: isSameProduct === v ? '#fff' : '#555',
                    fontWeight: isSameProduct === v ? 600 : 400,
                    transition: 'all 0.15s',
                  }}>
                  {label}
                </button>
              ))}
            </div>
            <span style={{ fontSize: 12, color: '#aaa' }}>
              {isSameProduct ? '✅ 脚本直接从视频台词压缩，产品信息作补充' : '🔄 仅学说话风格，台词从产品信息重新生成'}
            </span>
          </div>

          {/* 标杆参考视频库（仅当该产品有真实投流数据时显示） */}
          {benchmarkVideos.length > 0 && (
            <div style={{ marginTop: 14, padding: 12, background: 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)', borderRadius: 8, border: '1px solid #fbbf24' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
                onClick={() => setShowBenchmarks(v => !v)}>
                <div>
                  <strong style={{ fontSize: 14, color: '#92400e' }}>
                    ⭐ 平台推荐：{benchmarkVideos.length} 条高 ROI 标杆视频
                  </strong>
                  <div style={{ fontSize: 11, color: '#78350f', marginTop: 2 }}>
                    基于该产品真实投流数据筛选（ROI &gt; 3 或 GMV &gt; $5000），最高 ROI {benchmarkVideos[0].roi?.toFixed(1) || '-'}
                  </div>
                </div>
                <span style={{ fontSize: 18, color: '#78350f' }}>{showBenchmarks ? '▼' : '▶'}</span>
              </div>
              {showBenchmarks && (
                <div style={{ marginTop: 12, display: 'grid', gap: 8, maxHeight: 360, overflowY: 'auto' }}>
                  {benchmarkVideos.map((bv, i) => {
                    const isSelected = tiktokVideoUrl === bv.video_url
                    return (
                      <div key={bv.video_id}
                        style={{
                          padding: 10, background: isSelected ? '#fef3c7' : '#fff',
                          border: isSelected ? '2px solid #f59e0b' : '1px solid #e5e7eb',
                          borderRadius: 6, transition: 'all 0.15s',
                        }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 13, fontWeight: 600, color: '#1f2937' }}>#{i + 1} @{bv.author_username}</span>
                              {bv.roi != null && (
                                <span style={{ fontSize: 11, padding: '2px 6px', background: bv.roi > 10 ? '#10b981' : '#3b82f6', color: '#fff', borderRadius: 3 }}>
                                  ROI {bv.roi.toFixed(2)}
                                </span>
                              )}
                              {bv.revenue != null && (
                                <span style={{ fontSize: 11, color: '#059669' }}>收入 ${bv.revenue.toFixed(0)}</span>
                              )}
                              {bv.play_6s_rate != null && (
                                <span style={{ fontSize: 11, color: '#6b7280' }}>6s播放率 {(bv.play_6s_rate * 100).toFixed(1)}%</span>
                              )}
                              {bv.cvr != null && bv.cvr > 0 && (
                                <span style={{ fontSize: 11, color: '#6b7280' }}>转化 {(bv.cvr * 100).toFixed(1)}%</span>
                              )}
                            </div>
                            <div style={{ fontSize: 12, color: '#4b5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {bv.title || '(无标题)'}
                            </div>
                            <a href={bv.video_url} target="_blank" rel="noreferrer"
                              style={{ fontSize: 11, color: '#6366f1', textDecoration: 'none' }}>
                              🔗 在 TikTok 查看 →
                            </a>
                          </div>
                          <button
                            onClick={() => { setTiktokVideoUrl(bv.video_url); setRefVideo([]) }}
                            style={{
                              padding: '6px 12px', fontSize: 12, border: 'none', borderRadius: 5,
                              cursor: 'pointer', flexShrink: 0,
                              background: isSelected ? '#10b981' : '#f59e0b',
                              color: '#fff', fontWeight: 600,
                            }}>
                            {isSelected ? '✓ 已选' : '用这条'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 补充说明 */}
        <div style={s.card}>
          <div style={s.cardTitle}>补充说明（可选）</div>
          <textarea style={s.textarea}
            placeholder="描述你想强调的卖点、风格或特殊要求…"
            value={description} onChange={e => setDescription(e.target.value)} />
        </div>

        {/* 生成设置 */}
        <div style={s.card}>
          <div style={s.cardTitle}>生成设置</div>
          <div style={{ marginBottom: 14, padding: 12, background: generationMode === 'agentic_segments' ? '#eff6ff' : '#f9fafb', borderRadius: 8, border: '1px solid', borderColor: generationMode === 'agentic_segments' ? '#93c5fd' : '#e5e7eb' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#1f2937', marginBottom: 8 }}>生成模式</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                onClick={() => setGenerationMode('single_pass')}
                style={{
                  padding: '8px 10px', fontSize: 12, border: '2px solid', borderColor: generationMode === 'single_pass' ? '#6366f1' : '#e5e7eb',
                  borderRadius: 6, background: generationMode === 'single_pass' ? '#eef2ff' : '#fff',
                  cursor: 'pointer', textAlign: 'left',
                  fontWeight: generationMode === 'single_pass' ? 600 : 400, color: generationMode === 'single_pass' ? '#4338ca' : '#374151',
                }}>
                传统单段<br/>
                <span style={{ fontSize: 10, fontWeight: 400, color: generationMode === 'single_pass' ? '#6366f1' : '#9ca3af' }}>
                  1 次 Seedance 直接生成整条视频
                </span>
              </button>
              <button
                onClick={() => setGenerationMode('agentic_segments')}
                style={{
                  padding: '8px 10px', fontSize: 12, border: '2px solid', borderColor: generationMode === 'agentic_segments' ? '#2563eb' : '#e5e7eb',
                  borderRadius: 6, background: generationMode === 'agentic_segments' ? '#dbeafe' : '#fff',
                  cursor: 'pointer', textAlign: 'left',
                  fontWeight: generationMode === 'agentic_segments' ? 600 : 400, color: generationMode === 'agentic_segments' ? '#1d4ed8' : '#374151',
                }}>
                Agent 分段实验<br/>
                <span style={{ fontSize: 10, fontWeight: 400, color: generationMode === 'agentic_segments' ? '#2563eb' : '#9ca3af' }}>
                  10s 以上优先拆成 2 段，当前成片不带音频
                </span>
              </button>
            </div>
            {generationMode === 'agentic_segments' && (
              <div style={{ fontSize: 11, color: '#1d4ed8', marginTop: 8 }}>
                首段用参考图 + 参考视频建立风格，后段用上一段末帧续写；若总时长小于 10 秒，会自动回退成 1 段实验视频。
              </div>
            )}
          </div>

          <div style={s.row}>
            <div style={s.field}>
              <label style={s.label}>产品品类</label>
              <select style={s.select} value={category} onChange={e => setCategory(e.target.value)}>
                {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div style={s.field}>
              <label style={s.label}>批量数量</label>
              <select style={{ ...s.select, opacity: generationMode === 'agentic_segments' ? 0.6 : 1 }} value={generationMode === 'agentic_segments' ? 1 : batchCount} onChange={e => setBatchCount(Number(e.target.value))} disabled={generationMode === 'agentic_segments'}>
                {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} 个视频</option>)}
              </select>
            </div>
            <div style={s.field}>
              <label style={s.label}>分辨率</label>
              <select style={s.select} value={resolution} onChange={e => setResolution(e.target.value)}>
                <option value="480p">480p（省费用）</option>
                <option value="720p">720p</option>
              </select>
            </div>
            <div style={s.field}>
              <label style={s.label}>时长（秒，最长 15s）</label>
              <input type="number" style={s.input} value={duration} min={5} max={15}
                onChange={e => setDuration(Number(e.target.value))} />
            </div>
          </div>

          {/* VARIANT 选择器：同一标杆视频的裂变（不同模特+场景） */}
          {variants.length > 0 && (
            <div style={{ marginTop: 14, padding: 12, background: '#f3f4f6', borderRadius: 8, border: '1px solid #e5e7eb' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#1f2937', marginBottom: 4 }}>
                🎭 模特/场景配方（用于同一标杆视频的裂变 - 防 TikTok 查重）
              </div>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 10 }}>
                选不同配方 = 同一标杆能产出多条不重复的 AI 视频。不选 = 让 Pass 1 自由判断
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 }}>
                <button
                  onClick={() => setVariantSeed(null)}
                  style={{
                    padding: '8px 10px', fontSize: 12, border: '2px solid', borderColor: variantSeed === null ? '#6366f1' : '#e5e7eb',
                    borderRadius: 6, background: variantSeed === null ? '#eef2ff' : '#fff',
                    cursor: 'pointer', textAlign: 'left',
                    fontWeight: variantSeed === null ? 600 : 400, color: variantSeed === null ? '#4338ca' : '#6b7280',
                  }}>
                  🎲 不指定<br/>
                  <span style={{ fontSize: 10, fontWeight: 400 }}>让 AI 自由判断</span>
                </button>
                {variants.map(v => (
                  <button key={v.seed}
                    onClick={() => setVariantSeed(v.seed)}
                    title={`${v.presenter}\n场景: ${v.scene}`}
                    style={{
                      padding: '8px 10px', fontSize: 12, border: '2px solid', borderColor: variantSeed === v.seed ? '#6366f1' : '#e5e7eb',
                      borderRadius: 6, background: variantSeed === v.seed ? '#eef2ff' : '#fff',
                      cursor: 'pointer', textAlign: 'left',
                      fontWeight: variantSeed === v.seed ? 600 : 400, color: variantSeed === v.seed ? '#4338ca' : '#374151',
                    }}>
                    #{v.seed} {v.label}<br/>
                    <span style={{ fontSize: 10, fontWeight: 400, color: variantSeed === v.seed ? '#6366f1' : '#9ca3af' }}>
                      鼠标悬停看详情
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: 14, padding: 12, background: skipReferenceVideo ? '#fef3c7' : '#f9fafb', borderRadius: 8, border: '1px solid', borderColor: skipReferenceVideo ? '#f59e0b' : '#e5e7eb' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#1f2937' }}>
              <input
                type="checkbox"
                checked={skipReferenceVideo}
                onChange={e => setSkipReferenceVideo(e.target.checked)}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
              🧪 跳过 Seedance reference_video（A/B 测试）
            </label>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6, marginLeft: 24 }}>
              Gemini 仍照常分析 TikTok 视频（DNA / shot_sequence），但不把切片传给 Seedance 当视觉参考。用来对比 reference_video 对成片的影响。
            </div>
          </div>

        </div>

        {error && <div style={s.err}>⚠️ {error}</div>}

        {(() => {
          const zeroAfterFilter = productSkuColor && productInfo && ((productInfo.mainImageUrls?.length || 0) + (productInfo.detailImageUrls?.length || 0)) === 0
          const submitDisabled = loading || !!zeroAfterFilter
          return (
        <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
          <button style={s.btnPrimary(submitDisabled)} onClick={handleSubmit} disabled={submitDisabled}>
            {loading ? '生成中…' : '🚀 开始生成'}
          </button>
          {jobStatus?.status === 'failed' && !loading && jobStatus?.retryKieSupported && (
            <button style={{ ...s.btnGhost, background: '#fef2f2', borderColor: '#fca5a5', color: '#b91c1c' }} onClick={handleRetryKie}>🔄 重试 kie</button>
          )}
          {jobStatus?.status === 'failed' && !loading && !jobStatus?.retryKieSupported && (
            <button style={{ ...s.btnGhost, background: '#fef2f2', borderColor: '#fca5a5', color: '#b91c1c' }} onClick={handleSubmit}>🔄 重试（完整流程）</button>
          )}
          {(jobId || error) && !loading && (
            <button style={s.btnGhost} onClick={resetVideoOnly} title="保留产品和SKU，只清空视频和结果">
              🔄 换视频再生成
            </button>
          )}
          {(jobId || error) && !loading && (
            <button style={{ ...s.btnGhost, fontSize: 12, color: '#999' }} onClick={reset}>完全重置</button>
          )}
        </div>
          )
        })()}

        {/* 进度 */}
        {loading && (() => {
          const label = jobStatus?.stepLabel || '准备中…'
          const subElapsed = subStepStart ? Math.floor((now - subStepStart) / 1000) : 0
          // 根据 stepLabel 给上下文提示
          let hint = ''
          let icon = '⏳'
          if (/Snaptik/.test(label)) { icon = '🔗'; hint = '通常 ~5 秒' }
          else if (/上传产品图|kie\.ai/.test(label)) { icon = '📤'; hint = '通常 10-30 秒' }
          else if (/Gemini 分析参考视频/.test(label)) { icon = '🧠'; hint = '通常 30-90 秒 (Pass 1)' }
          else if (/上传选中.*kie\.ai/.test(label)) { icon = '🖼️'; hint = '通常 10-20 秒' }
          else if (/截取参考视频片段/.test(label)) { icon = '✂️'; hint = '通常 5-15 秒' }
          else if (/程序化校验/.test(label)) { icon = '🛡️'; hint = '即时' }
          else if (/二次评估/.test(label)) { icon = '🔍'; hint = 'Gemini 审查 prompt 质量，~30 秒' }
          else if (/修订/.test(label)) { icon = '✏️'; hint = 'AI 自动修订 — 最多 2 轮，2 轮还过不了整体 fail' }
          else if (/创建.*Seedance/.test(label)) { icon = '🎬'; hint = '即时' }
          else if (/Seedance 生成中/.test(label)) {
            icon = '⏳'
            hint = `Seedance 排队 + 生成，通常 5-25 分钟${taskState ? ` · 当前 kie.ai: ${taskState}` : ''}`
          }
          return (
            <div style={s.card}>
              <div style={s.cardTitle}>处理进度</div>
              {/* 当前活跃步骤大图标 + 实时 label + elapsed */}
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', padding: '12px 0 14px', borderBottom: '1px solid #f3f3f3', marginBottom: 10 }}>
                <div style={{ fontSize: 32 }}>{icon}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: '#111', marginBottom: 2 }}>{label}</div>
                  <div style={{ fontSize: 12, color: '#888' }}>
                    本步骤已 {fmtTime(subElapsed)}{hint && ` · ${hint}`}
                  </div>
                  <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>总耗时 {fmtTime(waitSec)}</div>
                </div>
              </div>
              {/* 4 个大阶段概览 */}
              {STEPS.map((step, i) => {
                const done = i < currentStep
                const active = i === currentStep
                return (
                  <div key={i} style={s.stepRow(done, active)}>
                    <div style={s.dot(done, active)}>{done ? '✓' : step.icon}</div>
                    <span>{step.label}</span>
                  </div>
                )
              })}
            </div>
          )
        })()}

        {/* 结果 */}
        {jobStatus && (
          <div style={s.card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>生成结果</span>
              <span style={s.pill(jobStatus.status)}>
                {jobStatus.status === 'completed' ? '✅ 完成' : jobStatus.status === 'failed' ? '❌ 失败' : '⏳ 生成中'}
              </span>
              {jobStatus.status === 'failed' && jobStatus.retryKieSupported && (
                <button
                  style={{ padding: '3px 12px', borderRadius: 6, border: '1px solid #fca5a5', background: '#fef2f2', color: '#b91c1c', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                  onClick={handleRetryKie}
                >🔄 重试 kie</button>
              )}
              {jobStatus.status === 'failed' && !jobStatus.retryKieSupported && (
                <button
                  style={{ padding: '3px 12px', borderRadius: 6, border: '1px solid #fca5a5', background: '#fef2f2', color: '#b91c1c', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                  onClick={handleSubmit}
                >🔄 重试（完整流程）</button>
              )}
              {jobStatus.status === 'completed' && (
                <button
                  style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #6366f1', background: '#eef2ff', color: '#6366f1', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                  onClick={resetVideoOnly}
                >🔄 换视频再生成</button>
              )}
              <span style={{ marginLeft: 'auto', fontSize: 12, color: '#aaa' }}>{jobId}</span>
            </div>

            {/* 视频 */}
            {jobStatus.videos?.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>生成的视频（{jobStatus.videos.length} 个）</div>
                {jobStatus.videos.map((v, i) => (
                  <div key={i} style={s.videoWrap}>
                    <video controls style={s.video} src={v.videoUrl} />
                    <div style={{ marginTop: 8, display: 'flex', gap: 12, alignItems: 'center' }}>
                      <a href={v.videoUrl} target="_blank" rel="noopener noreferrer" download
                        style={{ fontSize: 13, color: '#6366f1', textDecoration: 'none', fontWeight: 500 }}>
                        ⬇ 下载视频
                      </a>
                      <span style={{ fontSize: 11, color: '#bbb' }}>Task: {v.taskId}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 等待中的任务状态 */}
            {jobStatus.status !== 'completed' && jobStatus.tasks?.length > 0 && (
              <div style={{ marginBottom: 16, padding: 12, background: '#f8f9ff', borderRadius: 8 }}>
                <div style={{ fontSize: 13, color: '#555', marginBottom: 6 }}>⏳ 已等待 {fmtTime(waitSec)}，每 15 秒自动刷新</div>
                {jobStatus.tasks.map((t, i) => (
                  <div key={i} style={{ fontSize: 13, color: t.state === 'fail' ? '#dc2626' : '#6366f1', marginTop: 4 }}>
                    任务 {t.segmentIndex || i + 1}{t.role ? ` · ${t.role}` : ''}：<strong>{t.state}</strong>
                    {t.progress != null && ` · ${t.progress}%`}
                    {t.failMsg && ` · ${t.failMsg}`}
                  </div>
                ))}
              </div>
            )}

            {/* 提示词 */}
            {jobStatus.prompt && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Seedance 提示词</div>
                <div style={s.promptBox}>{jobStatus.prompt}</div>
                <button style={s.copyBtn} onClick={copyPrompt}>
                  {copied ? '✅ 已复制' : '复制提示词'}
                </button>
              </div>
            )}

            {/* 口播脚本 */}
            {jobStatus.compressedScript && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>压缩口播脚本</div>
                <div style={s.promptBox}>{jobStatus.compressedScript}</div>
              </div>
            )}

            {/* 选中图片 */}
            {jobStatus.selectedImages?.length > 0 && (
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>AI 选中的图片</div>
                {jobStatus.selectedImages.map(i => (
                  <span key={i} style={s.tag}>图片 {i}</span>
                ))}
                {jobStatus.reasoning && (
                  <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>{jobStatus.reasoning}</div>
                )}
              </div>
            )}
          </div>
        )}

        </>
        )}
      </div>
    </div>
  )
}
