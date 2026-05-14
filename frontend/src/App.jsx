import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'

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
  const [refVideo, setRefVideo] = useState([])
  const [tiktokVideoUrl, setTiktokVideoUrl] = useState('')
  const [images, setImages] = useState([])
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('lingerie')
  const [productUrl, setProductUrl] = useState('')
  const [productRegion, setProductRegion] = useState('SG')
  const [productInfo, setProductInfo] = useState(null)
  const [fetchingProduct, setFetchingProduct] = useState(false)
  const [productError, setProductError] = useState(null)
  const [isSameProduct, setIsSameProduct] = useState(true)
  const [batchCount, setBatchCount] = useState(1)
  const [resolution, setResolution] = useState('480p')
  const [duration, setDuration] = useState(15)
  const [jobId, setJobId] = useState(null)
  const [jobStatus, setJobStatus] = useState(null)
  const [loading, setLoading] = useState(false)
  const [currentStep, setCurrentStep] = useState(-1)
  const [error, setError] = useState(null)
  const [waitSec, setWaitSec] = useState(0)
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
    if (!refVideo[0] || images.length === 0) {
      setError('请先上传参考视频和至少一张产品图')
      return
    }
    setError(null); setLoading(true); setJobStatus(null); setCurrentStep(0)
    const fd = new FormData()
    fd.append('referenceVideo', refVideo[0])
    images.forEach(img => fd.append('productImages', img))
    if (tiktokVideoUrl) fd.append('tiktokVideoUrl', tiktokVideoUrl)
    fd.append('userDescription', description)
    fd.append('category', category)
    if (productInfo) fd.append('productInfo', JSON.stringify(productInfo))
    fd.append('isSameProduct', isSameProduct ? '1' : '0')
    fd.append('batchCount', batchCount)
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
    setProductUrl(''); setProductInfo(null); setProductError(null); setIsSameProduct(true)
    setJobId(null); setJobStatus(null); setLoading(false)
    setCurrentStep(-1); setError(null); setWaitSec(0); setCategory('lingerie')
  }

  const copyPrompt = () => {
    navigator.clipboard.writeText(jobStatus.prompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  const taskState = jobStatus?.tasks?.[0]?.state

  return (
    <div style={s.root}>
      <div style={s.wrap}>
        <h1 style={s.h1}>🎬 AI 带货视频生成器</h1>
        <p style={s.sub}>上传参考视频 + 产品图 → AI 自动分析风格并生成视频</p>

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
        </div>

        {/* 产品图 */}
        <div style={s.card}>
          <div style={s.cardTitle}>产品图（{images.length} / 20）</div>
          <DropZone label="上传产品图（最多 20 张）" accept="image/*" multiple type="image"
            files={images} onFiles={f => setImages(prev => [...prev, ...f].slice(0, 20))} />
          {images.length > 0 && (
            <>
              <div style={s.grid}>
                {imagePreviews.map((src, i) => (
                  <div key={i} style={{ position: 'relative' }}>
                    <img src={src} alt={`img-${i + 1}`} style={s.thumb} />
                    <div style={s.badge}>{i + 1}</div>
                    <button style={s.rmBtn} onClick={e => { e.stopPropagation(); setImages(prev => prev.filter((_, idx) => idx !== i)) }}>×</button>
                  </div>
                ))}
              </div>
              <button style={{ ...s.btnGhost, marginTop: 10, fontSize: 12, padding: '5px 12px' }} onClick={() => setImages([])}>
                清空全部
              </button>
            </>
          )}
        </div>

        {/* 商品信息 */}
        <div style={s.card}>
          <div style={s.cardTitle}>商品信息（可选，推荐填写）</div>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 10 }}>
            填入 TikTok Shop 商品链接，自动抓取面料、风格等信息，让 AI 生成更准确的面料描述。
            <span style={{ color: '#f59e0b' }}> ⚠️ Region 必须与商品所在地区一致，否则接口不返回数据。</span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input
              style={{ ...s.input, flex: 1 }}
              placeholder="粘贴 TikTok Shop 商品链接或 product_id…"
              value={productUrl}
              onChange={e => setProductUrl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && fetchProduct()}
            />
            <select style={{ ...s.select, width: 90, flexShrink: 0 }}
              value={productRegion} onChange={e => setProductRegion(e.target.value)}>
              {REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <button
              style={{ ...s.btnPrimary(fetchingProduct || !productUrl.trim()), padding: '8px 16px', fontSize: 13, flexShrink: 0 }}
              onClick={fetchProduct}
              disabled={fetchingProduct || !productUrl.trim()}>
              {fetchingProduct ? '抓取中…' : '抓取'}
            </button>
          </div>
          {productError && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#be123c' }}>⚠️ {productError}</div>
          )}
          {productInfo && (
            <div style={{ marginTop: 12, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: 12, fontSize: 13 }}>
              <div style={{ fontWeight: 600, color: '#15803d', marginBottom: 6 }}>✅ 商品信息已抓取</div>
              <div style={{ color: '#166534', lineHeight: 1.7 }}>
                <div><strong>商品名：</strong>{productInfo.name}</div>
                {productInfo.materials && <div><strong>材质：</strong>{productInfo.materials}</div>}
                {productInfo.style && <div><strong>风格：</strong>{productInfo.style}</div>}
                {productInfo.season && <div><strong>季节：</strong>{productInfo.season}</div>}
                {productInfo.design && <div><strong>设计：</strong>{productInfo.design}</div>}
                {productInfo.variants?.map((v, i) => (
                  <div key={i}><strong>{v.name}：</strong>{v.values.join(' / ')}</div>
                ))}
                {productInfo.price && <div><strong>价格：</strong>{productInfo.price}</div>}
                {productInfo.categories?.length > 0 && (
                  <div><strong>品类：</strong>{productInfo.categories.join(' > ')}</div>
                )}
              </div>
              <button style={{ ...s.btnGhost, marginTop: 8, fontSize: 12, padding: '3px 10px', color: '#dc2626', borderColor: '#fca5a5' }}
                onClick={() => { setProductInfo(null); setProductUrl('') }}>
                清除
              </button>
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
          <div style={s.row}>
            <div style={s.field}>
              <label style={s.label}>产品品类</label>
              <select style={s.select} value={category} onChange={e => setCategory(e.target.value)}>
                {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div style={s.field}>
              <label style={s.label}>批量数量</label>
              <select style={s.select} value={batchCount} onChange={e => setBatchCount(Number(e.target.value))}>
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
        </div>

        {error && <div style={s.err}>⚠️ {error}</div>}

        <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
          <button style={s.btnPrimary(loading)} onClick={handleSubmit} disabled={loading}>
            {loading ? '生成中…' : '🚀 开始生成'}
          </button>
          {(jobId || error) && (
            <button style={s.btnGhost} onClick={reset}>重置</button>
          )}
        </div>

        {/* 进度 */}
        {loading && (
          <div style={s.card}>
            <div style={s.cardTitle}>处理进度</div>
            {STEPS.map((step, i) => {
              const done = i < currentStep
              const active = i === currentStep
              return (
                <div key={i} style={s.stepRow(done, active)}>
                  <div style={s.dot(done, active)}>
                    {done ? '✓' : step.icon}
                  </div>
                  <span>{step.label}</span>
                  {active && (
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6366f1' }}>
                      {i === 3
                        ? `${fmtTime(waitSec)} ${taskState ? `· ${taskState}` : ''}`
                        : jobStatus?.stepLabel || '进行中…'}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* 结果 */}
        {jobStatus && (
          <div style={s.card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>生成结果</span>
              <span style={s.pill(jobStatus.status)}>
                {jobStatus.status === 'completed' ? '✅ 完成' : jobStatus.status === 'failed' ? '❌ 失败' : '⏳ 生成中'}
              </span>
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
            {jobStatus.status === 'pending' && jobStatus.tasks?.length > 0 && (
              <div style={{ marginBottom: 16, padding: 12, background: '#f8f9ff', borderRadius: 8 }}>
                <div style={{ fontSize: 13, color: '#555', marginBottom: 6 }}>⏳ 已等待 {fmtTime(waitSec)}，每 15 秒自动刷新</div>
                {jobStatus.tasks.map((t, i) => (
                  <div key={i} style={{ fontSize: 13, color: t.state === 'fail' ? '#dc2626' : '#6366f1', marginTop: 4 }}>
                    任务 {i + 1}：<strong>{t.state}</strong>
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
      </div>
    </div>
  )
}
