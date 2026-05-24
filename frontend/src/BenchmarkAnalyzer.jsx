import React, { useState, useMemo, useEffect } from 'react'

const API = '/api'

const s = {
  wrap: { maxWidth: 980, margin: '0 auto' },
  card: { background: '#fff', borderRadius: 10, padding: 20, marginBottom: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.07)' },
  title: { fontSize: 18, fontWeight: 700, color: '#111', margin: '0 0 6px' },
  sub: { fontSize: 13, color: '#666', marginBottom: 16 },
  input: { width: '100%', padding: 10, borderRadius: 8, border: '1px solid #ddd', boxSizing: 'border-box' },
  btn: disabled => ({ padding: '10px 18px', borderRadius: 8, border: 'none', background: disabled ? '#c7c7c7' : '#2563eb', color: '#fff', fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer' }),
  err: { background: '#fff1f2', border: '1px solid #fecdd3', color: '#be123c', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 13 },
  ok: { background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#15803d', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 13 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 },
  metric: { background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 12 },
  metricLabel: { fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 },
  metricValue: { fontSize: 20, fontWeight: 800, color: '#0f172a', marginTop: 4 },
  sectionTitle: { fontSize: 13, fontWeight: 800, color: '#334155', textTransform: 'uppercase', letterSpacing: 0.5, margin: '18px 0 10px' },
  pre: { background: '#0f172a', color: '#e2e8f0', borderRadius: 8, padding: 14, fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowX: 'auto', maxHeight: 360 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: { textAlign: 'left', padding: '8px 6px', borderBottom: '1px solid #e5e7eb', color: '#475569' },
  td: { padding: '8px 6px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'top', color: '#334155' },
  pill: { display: 'inline-block', padding: '2px 7px', borderRadius: 999, background: '#e0f2fe', color: '#0369a1', fontSize: 11, fontWeight: 700 },
}

function JsonBlock({ value }) {
  return <pre style={s.pre}>{JSON.stringify(value, null, 2)}</pre>
}

function TimelineTable({ rows = [] }) {
  if (!rows.length) return <div style={s.sub}>No timeline items returned.</div>
  return (
    <table style={s.table}>
      <thead>
        <tr>
          <th style={s.th}>Time</th>
          <th style={s.th}>Role</th>
          <th style={s.th}>Visual / Action</th>
          <th style={s.th}>Spoken</th>
          <th style={s.th}>Product</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            <td style={s.td}>{row.start}-{row.end}s</td>
            <td style={s.td}><span style={s.pill}>{row.role || row.shot_type || 'shot'}</span></td>
            <td style={s.td}>{row.visual || row.action || ''}<br /><span style={{ color: '#64748b' }}>{row.camera || ''}</span></td>
            <td style={s.td}>{row.spoken_line || ''}</td>
            <td style={s.td}>{row.product_visibility || ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default function BenchmarkAnalyzer() {
  const [file, setFile] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const previewUrl = useMemo(() => file ? URL.createObjectURL(file) : null, [file])

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  const analyze = async () => {
    if (!file || loading) return
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const fd = new FormData()
      fd.append('benchmarkVideo', file)
      fd.append('baseFps', '1')
      fd.append('hookFps', '4')
      fd.append('hookDuration', '3')
      fd.append('maxFrames', '60')
      const res = await fetch(`${API}/benchmark/analyze`, { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Benchmark analysis failed')
      setResult(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const template = result?.template

  return (
    <div style={s.wrap}>
      <div style={s.card}>
        <h2 style={s.title}>标杆分析器</h2>
        <div style={s.sub}>上传一个优质 AI 视频，系统会先做显式 ASR、抽帧和场景切分，再输出可复刻的结构化模板。</div>
        <input
          style={s.input}
          type="file"
          accept="video/*"
          onChange={e => setFile(e.target.files?.[0] || null)}
        />
        {previewUrl && (
          <video src={previewUrl} controls style={{ width: '100%', maxHeight: 380, marginTop: 12, borderRadius: 8, background: '#000' }} />
        )}
        <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
          <button style={s.btn(!file || loading)} disabled={!file || loading} onClick={analyze}>
            {loading ? '分析中...' : '分析标杆'}
          </button>
          {file && <span style={{ fontSize: 12, color: '#64748b' }}>{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</span>}
        </div>
      </div>

      {error && <div style={s.err}>{error}</div>}
      {loading && <div style={s.ok}>正在抽帧、转写台词并让 Gemini 拆解镜头结构。视频越长，等待越久。</div>}

      {result && (
        <>
          <div style={s.card}>
            <h3 style={s.title}>分析结果</h3>
            <div style={s.grid}>
              <div style={s.metric}><div style={s.metricLabel}>Duration</div><div style={s.metricValue}>{Number(result.video?.duration || 0).toFixed(1)}s</div></div>
              <div style={s.metric}><div style={s.metricLabel}>Frames</div><div style={s.metricValue}>{result.extraction?.frameCount || 0}</div></div>
              <div style={s.metric}><div style={s.metricLabel}>Validation</div><div style={s.metricValue}>{result.validation?.pass ? 'PASS' : 'CHECK'}</div></div>
              <div style={s.metric}><div style={s.metricLabel}>Hook</div><div style={{ ...s.metricValue, fontSize: 15 }}>{template?.hook_type || 'unknown'}</div></div>
            </div>
            {!result.validation?.pass && <JsonBlock value={result.validation} />}
          </div>

          <div style={s.card}>
            <h3 style={s.title}>Summary</h3>
            <div style={{ fontSize: 14, lineHeight: 1.65, color: '#334155' }}>{template?.summary}</div>
            <div style={s.sectionTitle}>Transcript</div>
            <JsonBlock value={result.transcript} />
          </div>

          <div style={s.card}>
            <h3 style={s.title}>Timeline</h3>
            <TimelineTable rows={template?.timeline || []} />
            <div style={s.sectionTitle}>Shot List</div>
            <TimelineTable rows={template?.shot_list || []} />
          </div>

          <div style={s.card}>
            <h3 style={s.title}>Replicable Template</h3>
            <JsonBlock value={template?.replicable_template || {}} />
            <div style={s.sectionTitle}>Prompt Recipe</div>
            <pre style={s.pre}>{template?.prompt_recipe || ''}</pre>
          </div>

          <div style={s.card}>
            <h3 style={s.title}>Risks And Scorecard</h3>
            <JsonBlock value={{ risks: template?.risks || [], scorecard: template?.scorecard || {} }} />
          </div>
        </>
      )}
    </div>
  )
}

