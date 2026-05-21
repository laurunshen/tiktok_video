import React, { useState, useEffect } from 'react'

const API = '/api'

const s = {
  wrap: { padding: '0 0 40px' },
  topBar: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 },
  addBtn: { padding: '9px 18px', borderRadius: 8, border: 'none', background: '#6366f1', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  empty: { textAlign: 'center', padding: '48px 0', color: '#888', fontSize: 14 },
  card: { background: '#fff', borderRadius: 12, padding: 16, marginBottom: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.07)' },
  cardHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 10 },
  videoLink: { color: '#6366f1', fontSize: 14, fontWeight: 600, textDecoration: 'none', wordBreak: 'break-all' },
  statsRow: { display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 8 },
  stat: { fontSize: 12, color: '#555' },
  statLabel: { color: '#888', marginRight: 4 },
  actions: { display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' },
  useBtn: { padding: '5px 12px', borderRadius: 6, border: 'none', background: '#6366f1', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  editBtn: { padding: '5px 10px', borderRadius: 6, border: '1px solid #ddd', background: '#fff', color: '#555', fontSize: 12, cursor: 'pointer' },
  delBtn: { padding: '5px 10px', borderRadius: 6, border: '1px solid #fecdd3', background: '#fff', color: '#b91c1c', fontSize: 12, cursor: 'pointer' },
  toggleBtn: { fontSize: 11, color: '#6366f1', cursor: 'pointer', userSelect: 'none', marginTop: 4, display: 'inline-block' },
  collapsed: { display: 'none' },
  codeBox: { marginTop: 6, padding: 10, background: '#f8fafc', borderRadius: 6, fontSize: 11, fontFamily: 'monospace', whiteSpace: 'pre-wrap', maxHeight: 180, overflowY: 'auto', color: '#475569' },
  notes: { fontSize: 12, color: '#444', marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 },
  modal: { background: '#fff', borderRadius: 14, padding: 28, width: '100%', maxWidth: 520, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' },
  modalTitle: { fontSize: 18, fontWeight: 700, marginBottom: 20, color: '#111' },
  fieldWrap: { marginBottom: 14 },
  label: { display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 5 },
  input: { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 14, outline: 'none', boxSizing: 'border-box' },
  textarea: { width: '100%', minHeight: 72, padding: '10px 12px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13, resize: 'vertical', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  row: { display: 'flex', gap: 12 },
  saveBtn: { padding: '10px 24px', borderRadius: 8, border: 'none', background: '#6366f1', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  cancelBtn: { padding: '10px 20px', borderRadius: 8, border: '1px solid #ddd', background: '#fff', color: '#555', fontSize: 14, cursor: 'pointer' },
  err: { color: '#b91c1c', fontSize: 12, marginBottom: 10 },
  scoreItem: { display: 'inline-block', padding: '2px 7px', borderRadius: 4, background: '#ede9fe', color: '#6d28d9', fontSize: 11, margin: '2px' },
}

function fmt(n, decimals = 0) {
  if (n == null) return '—'
  return Number(n).toFixed(decimals)
}

function ScoreChips({ rawJson }) {
  if (!rawJson) return null
  let obj
  try { obj = JSON.parse(rawJson) } catch { return <span style={{ fontSize: 11, color: '#888' }}>（解析失败）</span> }
  const entries = Object.entries(obj)
  if (!entries.length) return null
  return (
    <div style={{ marginTop: 4, flexWrap: 'wrap', display: 'flex' }}>
      {entries.map(([k, v]) => (
        <span key={k} style={s.scoreItem}>{k}: {typeof v === 'object' ? JSON.stringify(v) : v}</span>
      ))}
    </div>
  )
}

function TemplateCard({ tpl, onUseVideo, onEdit, onDelete }) {
  const [showScores, setShowScores] = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)

  const convRate = (tpl.views && tpl.orders)
    ? ((tpl.orders / tpl.views) * 100).toFixed(2)
    : null

  return (
    <div style={s.card}>
      <div style={s.cardHeader}>
        <a href={tpl.video_url} target="_blank" rel="noreferrer" style={s.videoLink}>
          🔗 {tpl.video_url.length > 80 ? tpl.video_url.slice(0, 80) + '…' : tpl.video_url}
        </a>
        <div style={s.actions}>
          <button style={s.useBtn} onClick={() => onUseVideo(tpl.video_url)}>▶ 去生成</button>
          <button style={s.editBtn} onClick={() => onEdit(tpl)}>✏️ 编辑</button>
          <button style={s.delBtn} onClick={() => onDelete(tpl.id)}>🗑️</button>
        </div>
      </div>

      <div style={s.statsRow}>
        <span style={s.stat}><span style={s.statLabel}>播放量</span>{fmt(tpl.views)}</span>
        <span style={s.stat}><span style={s.statLabel}>出单数</span>{fmt(tpl.orders)}</span>
        <span style={s.stat}><span style={s.statLabel}>CTR</span>{tpl.ctr != null ? fmt(tpl.ctr, 2) + '%' : '—'}</span>
        <span style={s.stat}><span style={s.statLabel}>播放→出单</span>{convRate != null ? convRate + '%' : '—'}</span>
        {tpl.job_id && <span style={s.stat}><span style={s.statLabel}>job</span>{tpl.job_id.slice(0, 12)}…</span>}
      </div>

      {tpl.notes && <div style={s.notes}>{tpl.notes}</div>}

      {tpl.review_scores && (
        <>
          <span style={s.toggleBtn} onClick={() => setShowScores(v => !v)}>
            {showScores ? '▼ 收起评分' : '▶ 展开 Gemini 评分'}
          </span>
          {showScores && <ScoreChips rawJson={tpl.review_scores} />}
        </>
      )}

      {tpl.prompt && (
        <>
          <div style={{ height: 0 }} />
          <span style={s.toggleBtn} onClick={() => setShowPrompt(v => !v)}>
            {showPrompt ? '▼ 收起 Prompt' : '▶ 展开 Prompt'}
          </span>
          {showPrompt && <div style={s.codeBox}>{tpl.prompt}</div>}
        </>
      )}
    </div>
  )
}

const EMPTY_FORM = { video_url: '', views: '', orders: '', ctr: '', notes: '', prompt: '', review_scores: '' }

export default function MyTemplates({ onUseVideo }) {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editId, setEditId] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [formErr, setFormErr] = useState(null)

  const fetchTemplates = async () => {
    try {
      const r = await fetch(`${API}/templates`)
      const data = await r.json()
      setTemplates(data.templates || [])
    } catch {}
    setLoading(false)
  }

  useEffect(() => { fetchTemplates() }, [])

  const openAdd = () => {
    setEditId(null)
    setForm(EMPTY_FORM)
    setFormErr(null)
    setShowModal(true)
  }

  const openEdit = (tpl) => {
    setEditId(tpl.id)
    setForm({
      video_url: tpl.video_url || '',
      views: tpl.views ?? '',
      orders: tpl.orders ?? '',
      ctr: tpl.ctr ?? '',
      notes: tpl.notes || '',
      prompt: tpl.prompt || '',
      review_scores: tpl.review_scores || '',
    })
    setFormErr(null)
    setShowModal(true)
  }

  const closeModal = () => { setShowModal(false); setFormErr(null) }

  const handleSave = async () => {
    if (!form.video_url.trim()) { setFormErr('视频链接为必填项'); return }
    setSaving(true); setFormErr(null)
    try {
      const body = {
        video_url: form.video_url.trim(),
        views: form.views !== '' ? Number(form.views) : null,
        orders: form.orders !== '' ? Number(form.orders) : null,
        ctr: form.ctr !== '' ? Number(form.ctr) : null,
        notes: form.notes || null,
        prompt: form.prompt || null,
        review_scores: form.review_scores || null,
      }
      if (editId) {
        const r = await fetch(`${API}/templates/${editId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!r.ok) { const d = await r.json(); throw new Error(d.error || `HTTP ${r.status}`) }
        const d = await r.json()
        setTemplates(prev => prev.map(t => t.id === editId ? d.template : t))
      } else {
        const r = await fetch(`${API}/templates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!r.ok) { const d = await r.json(); throw new Error(d.error || `HTTP ${r.status}`) }
        const d = await r.json()
        setTemplates(prev => [d.template, ...prev])
      }
      closeModal()
    } catch (e) {
      setFormErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id) => {
    if (!window.confirm('确定删除这条模板？')) return
    try {
      const r = await fetch(`${API}/templates/${id}`, { method: 'DELETE' })
      if (!r.ok) { const d = await r.json(); throw new Error(d.error || `HTTP ${r.status}`) }
      setTemplates(prev => prev.filter(t => t.id !== id))
    } catch (e) {
      alert('删除失败：' + e.message)
    }
  }

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  return (
    <div style={s.wrap}>
      <div style={s.topBar}>
        <button style={s.addBtn} onClick={openAdd}>+ 手动添加模板</button>
        <span style={{ fontSize: 13, color: '#888' }}>共 {templates.length} 条</span>
      </div>

      {loading ? (
        <div style={s.empty}>加载中…</div>
      ) : templates.length === 0 ? (
        <div style={s.empty}>还没有模板，把你验证过的高转化视频存进来</div>
      ) : (
        templates.map(tpl => (
          <TemplateCard
            key={tpl.id}
            tpl={tpl}
            onUseVideo={onUseVideo}
            onEdit={openEdit}
            onDelete={handleDelete}
          />
        ))
      )}

      {showModal && (
        <div style={s.overlay} onClick={closeModal}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalTitle}>{editId ? '编辑模板' : '添加模板'}</div>

            {formErr && <div style={s.err}>⚠️ {formErr}</div>}

            <div style={s.fieldWrap}>
              <label style={s.label}>视频链接 *</label>
              <input style={s.input} value={form.video_url} onChange={set('video_url')} placeholder="https://www.tiktok.com/video/…" />
            </div>

            <div style={{ ...s.row, marginBottom: 14 }}>
              <div style={{ flex: 1 }}>
                <label style={s.label}>播放量</label>
                <input style={s.input} type="number" value={form.views} onChange={set('views')} placeholder="0" />
              </div>
              <div style={{ flex: 1 }}>
                <label style={s.label}>出单数</label>
                <input style={s.input} type="number" value={form.orders} onChange={set('orders')} placeholder="0" />
              </div>
              <div style={{ flex: 1 }}>
                <label style={s.label}>CTR (%)</label>
                <input style={s.input} type="number" step="0.01" value={form.ctr} onChange={set('ctr')} placeholder="0.00" />
              </div>
            </div>

            <div style={s.fieldWrap}>
              <label style={s.label}>备注</label>
              <textarea style={s.textarea} value={form.notes} onChange={set('notes')} placeholder="备注信息…" />
            </div>

            <div style={s.fieldWrap}>
              <label style={s.label}>Prompt（可选）</label>
              <textarea style={{ ...s.textarea, minHeight: 88 }} value={form.prompt} onChange={set('prompt')} placeholder="生成时用的 prompt…" />
            </div>

            <div style={s.fieldWrap}>
              <label style={s.label}>Gemini 评分（JSON 格式，可选）</label>
              <textarea style={s.textarea} value={form.review_scores} onChange={set('review_scores')} placeholder='{"product_accuracy": 9, "natural_ugc_feel": 8, …}' />
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
              <button style={s.cancelBtn} onClick={closeModal}>取消</button>
              <button style={s.saveBtn} disabled={saving} onClick={handleSave}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
