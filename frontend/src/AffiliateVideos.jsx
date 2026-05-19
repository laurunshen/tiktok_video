import React, { useState, useEffect, useCallback } from 'react'

const API = '/api'

const SORT_OPTIONS = [
  { value: 'affiliate_gmv',      label: 'GMV' },
  { value: 'affiliate_rpm',      label: 'RPM（千次曝光成交）' },
  { value: 'impressions',        label: '曝光量' },
  { value: 'affiliate_orders',   label: '订单量' },
  { value: 'affiliate_likes',    label: '点赞数' },
  { value: 'affiliate_comments', label: '评论数' },
  { value: 'ctr',                label: '点击率' },
  { value: 'published_at',       label: '发布日期' },
]

const fmt = (n, prefix = '') => {
  if (n == null) return '—'
  if (n >= 1000000) return prefix + (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000)    return prefix + (n / 1000).toFixed(1) + 'K'
  return prefix + Number(n).toFixed(n % 1 === 0 ? 0 : 2)
}
const fmtMoney = n => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
const fmtCtr   = n => n == null ? '—' : Number(n).toFixed(2) + '%'

const s = {
  root: { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  filterBar: {
    display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16,
    padding: 14, background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0',
  },
  filterGroup: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 130 },
  label: { fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 },
  input: { padding: '6px 10px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box' },
  select: { padding: '6px 10px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13, background: '#fff', outline: 'none', cursor: 'pointer', width: '100%' },
  btnPrimary: { padding: '7px 18px', borderRadius: 7, border: 'none', background: '#6366f1', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  btnGhost: { padding: '7px 14px', borderRadius: 7, border: '1px solid #ddd', background: '#fff', fontSize: 13, color: '#555', cursor: 'pointer' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { padding: '10px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: '2px solid #e2e8f0', background: '#f8fafc', whiteSpace: 'nowrap' },
  td: { padding: '10px 12px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'middle' },
  pill: c => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: c, color: '#fff' }),
  pager: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, fontSize: 13, color: '#64748b' },
  stat: { display: 'inline-block', marginRight: 20, fontSize: 12, color: '#64748b' },
}

export default function AffiliateVideos({ onUseVideo }) {
  const [videos, setVideos]   = useState([])
  const [total, setTotal]     = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)

  // 筛选条件
  const [author,   setAuthor]   = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo,   setDateTo]   = useState('')
  const [minGmv,   setMinGmv]   = useState('')
  const [maxGmv,   setMaxGmv]   = useState('')
  const [sort,     setSort]     = useState('affiliate_gmv')
  const [order,    setOrder]    = useState('desc')
  const [page,     setPage]     = useState(1)
  const limit = 50

  const fetch_ = useCallback(async (opts = {}) => {
    setLoading(true)
    setError(null)
    const p = new URLSearchParams()
    const _page  = opts.page  ?? page
    const _sort  = opts.sort  ?? sort
    const _order = opts.order ?? order
    p.set('page', _page)
    p.set('limit', limit)
    p.set('sort', _sort)
    p.set('order', _order)
    if (author)   p.set('author', author)
    if (dateFrom) p.set('dateFrom', dateFrom)
    if (dateTo)   p.set('dateTo', dateTo)
    if (minGmv)   p.set('minGmv', minGmv)
    if (maxGmv)   p.set('maxGmv', maxGmv)
    try {
      const res  = await fetch(`${API}/product/affiliate-videos?${p}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '请求失败')
      setVideos(data.videos || [])
      setTotal(data.total || 0)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [page, sort, order, author, dateFrom, dateTo, minGmv, maxGmv])

  // 初始加载
  useEffect(() => { fetch_() }, []) // eslint-disable-line

  const handleSearch = () => { setPage(1); fetch_({ page: 1 }) }
  const handleReset  = () => {
    setAuthor(''); setDateFrom(''); setDateTo(''); setMinGmv(''); setMaxGmv('')
    setSort('affiliate_gmv'); setOrder('desc'); setPage(1)
    fetch_({ page: 1, sort: 'affiliate_gmv', order: 'desc' })
  }

  const handleSort = col => {
    const newOrder = sort === col && order === 'desc' ? 'asc' : 'desc'
    setSort(col); setOrder(newOrder); setPage(1)
    fetch_({ page: 1, sort: col, order: newOrder })
  }

  const handlePage = newPage => { setPage(newPage); fetch_({ page: newPage }) }

  const totalPages = Math.ceil(total / limit)

  const sortIcon = col => sort === col ? (order === 'desc' ? ' ▼' : ' ▲') : ''

  // 汇总统计
  const totalGmv    = videos.reduce((s, v) => s + (v.affiliate_gmv || 0), 0)
  const totalOrders = videos.reduce((s, v) => s + (v.affiliate_orders || 0), 0)
  const totalImpr   = videos.reduce((s, v) => s + (v.impressions || 0), 0)

  return (
    <div style={s.root}>
      {/* 筛选栏 */}
      <div style={s.filterBar}>
        <div style={s.filterGroup}>
          <label style={s.label}>达人用户名</label>
          <input style={s.input} placeholder="搜索达人…" value={author}
            onChange={e => setAuthor(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()} />
        </div>
        <div style={s.filterGroup}>
          <label style={s.label}>发布日期（从）</label>
          <input style={s.input} type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        </div>
        <div style={s.filterGroup}>
          <label style={s.label}>发布日期（至）</label>
          <input style={s.input} type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
        </div>
        <div style={s.filterGroup}>
          <label style={s.label}>最低 GMV ($)</label>
          <input style={s.input} type="number" placeholder="0" value={minGmv} onChange={e => setMinGmv(e.target.value)} />
        </div>
        <div style={s.filterGroup}>
          <label style={s.label}>最高 GMV ($)</label>
          <input style={s.input} type="number" placeholder="不限" value={maxGmv} onChange={e => setMaxGmv(e.target.value)} />
        </div>
        <div style={s.filterGroup}>
          <label style={s.label}>排序</label>
          <select style={s.select} value={sort} onChange={e => { setSort(e.target.value); setPage(1); fetch_({ page: 1, sort: e.target.value }) }}>
            {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div style={s.filterGroup}>
          <label style={s.label}>顺序</label>
          <select style={s.select} value={order} onChange={e => { setOrder(e.target.value); setPage(1); fetch_({ page: 1, order: e.target.value }) }}>
            <option value="desc">高 → 低</option>
            <option value="asc">低 → 高</option>
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <button style={s.btnPrimary} onClick={handleSearch}>筛选</button>
          <button style={s.btnGhost}   onClick={handleReset}>重置</button>
        </div>
      </div>

      {/* 汇总数字 */}
      {!loading && videos.length > 0 && (
        <div style={{ marginBottom: 12, fontSize: 12, color: '#64748b' }}>
          <span style={s.stat}>共 <strong>{total.toLocaleString()}</strong> 条</span>
          <span style={s.stat}>本页 GMV <strong>{fmtMoney(totalGmv)}</strong></span>
          <span style={s.stat}>本页订单 <strong>{fmt(totalOrders)}</strong></span>
          <span style={s.stat}>本页曝光 <strong>{fmt(totalImpr)}</strong></span>
        </div>
      )}

      {error && <div style={{ padding: 12, background: '#fff1f2', border: '1px solid #fecdd3', borderRadius: 8, color: '#be123c', fontSize: 13, marginBottom: 12 }}>⚠️ {error}</div>}

      {/* 表格 */}
      <div style={{ overflowX: 'auto', background: '#fff', borderRadius: 10, border: '1px solid #e2e8f0' }}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={{ ...s.th, minWidth: 280 }}>视频</th>
              <th style={{ ...s.th, cursor: 'pointer' }} onClick={() => handleSort('published_at')}>发布日期{sortIcon('published_at')}</th>
              <th style={{ ...s.th, cursor: 'pointer' }} onClick={() => handleSort('affiliate_gmv')}>GMV{sortIcon('affiliate_gmv')}</th>
              <th style={{ ...s.th, cursor: 'pointer' }} onClick={() => handleSort('affiliate_orders')}>订单{sortIcon('affiliate_orders')}</th>
              <th style={{ ...s.th, cursor: 'pointer' }} onClick={() => handleSort('affiliate_rpm')}>RPM{sortIcon('affiliate_rpm')}</th>
              <th style={{ ...s.th, cursor: 'pointer' }} onClick={() => handleSort('impressions')}>曝光{sortIcon('impressions')}</th>
              <th style={{ ...s.th, cursor: 'pointer' }} onClick={() => handleSort('ctr')}>CTR{sortIcon('ctr')}</th>
              <th style={{ ...s.th, cursor: 'pointer' }} onClick={() => handleSort('affiliate_likes')}>点赞{sortIcon('affiliate_likes')}</th>
              <th style={s.th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} style={{ ...s.td, textAlign: 'center', color: '#94a3b8', padding: 40 }}>加载中…</td></tr>
            ) : videos.length === 0 ? (
              <tr><td colSpan={9} style={{ ...s.td, textAlign: 'center', color: '#94a3b8', padding: 40 }}>暂无数据</td></tr>
            ) : videos.map(v => (
              <tr key={v.video_id} style={{ transition: 'background 0.1s' }}
                onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                onMouseLeave={e => e.currentTarget.style.background = ''}>
                <td style={s.td}>
                  <div style={{ fontWeight: 600, color: '#1e293b', marginBottom: 2, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', lineHeight: 1.4 }}>
                    {v.title || '(无标题)'}
                  </div>
                  <div style={{ fontSize: 12, color: '#6366f1', fontWeight: 500 }}>@{v.author_username || '—'}</div>
                </td>
                <td style={{ ...s.td, whiteSpace: 'nowrap', color: '#64748b' }}>{v.published_at || '—'}</td>
                <td style={{ ...s.td, fontWeight: 700, color: v.affiliate_gmv > 5000 ? '#059669' : '#1e293b' }}>
                  {fmtMoney(v.affiliate_gmv)}
                  {v.affiliate_refund_gmv > 0 && (
                    <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 400 }}>退款 {fmtMoney(v.affiliate_refund_gmv)}</div>
                  )}
                </td>
                <td style={{ ...s.td, color: '#1e293b' }}>{fmt(v.affiliate_orders)}</td>
                <td style={{ ...s.td, fontWeight: 600, color: v.affiliate_rpm > 5 ? '#d97706' : '#1e293b' }}>
                  {v.affiliate_rpm != null ? '$' + Number(v.affiliate_rpm).toFixed(2) : '—'}
                </td>
                <td style={{ ...s.td, color: '#64748b' }}>{fmt(v.impressions)}</td>
                <td style={{ ...s.td, color: '#64748b' }}>{fmtCtr(v.ctr)}</td>
                <td style={{ ...s.td, color: '#64748b' }}>{fmt(v.affiliate_likes)}</td>
                <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                  <a href={v.video_url} target="_blank" rel="noreferrer"
                    style={{ fontSize: 12, color: '#6366f1', textDecoration: 'none', fontWeight: 500, marginRight: 10 }}>
                    🔗 TikTok
                  </a>
                  {onUseVideo && v.video_url && (
                    <button
                      onClick={() => onUseVideo(v.video_url)}
                      style={{
                        fontSize: 11, padding: '3px 8px', borderRadius: 5, border: 'none',
                        background: '#6366f1', color: '#fff', cursor: 'pointer', fontWeight: 600,
                      }}>
                      ▶ 去生成
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 翻页 */}
      {totalPages > 1 && (
        <div style={s.pager}>
          <span>第 {page} / {totalPages} 页，共 {total.toLocaleString()} 条</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={s.btnGhost} disabled={page <= 1} onClick={() => handlePage(1)}>«</button>
            <button style={s.btnGhost} disabled={page <= 1} onClick={() => handlePage(page - 1)}>‹</button>
            {(() => {
              const startPage = Math.max(1, Math.min(page - 2, totalPages - 4))
              return [...Array(Math.min(5, totalPages))].map((_, i) => {
              const p = startPage + i
              return (
                <button key={p} style={{ ...s.btnGhost, background: p === page ? '#6366f1' : '#fff', color: p === page ? '#fff' : '#555', borderColor: p === page ? '#6366f1' : '#ddd' }}
                  onClick={() => handlePage(p)}>{p}</button>
              )
            })
            })()}
            <button style={s.btnGhost} disabled={page >= totalPages} onClick={() => handlePage(page + 1)}>›</button>
            <button style={s.btnGhost} disabled={page >= totalPages} onClick={() => handlePage(totalPages)}>»</button>
          </div>
        </div>
      )}
    </div>
  )
}
