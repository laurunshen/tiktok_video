// before-after 概念助手路由（独立，不影响主生成流程）
import express from 'express'
import { extractSellingPoints, generateBeforeAfterConcepts } from '../services/before-after.js'

const router = express.Router()

// 第 1 步：识别卖点
// body: { productInfo: {...} }  —— productInfo 里含 name / mainImageUrls / detailImageUrls 等
router.post('/selling-points', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const productInfo = req.body.productInfo || {}
    const sellingPoints = await extractSellingPoints({
      productInfo,
      mainImageUrls: productInfo.mainImageUrls || [],
      detailImageUrls: productInfo.detailImageUrls || [],
    })
    res.json({ sellingPoints })
  } catch (e) {
    console.error('[before-after] 识别卖点失败:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// 第 2 步：根据选中卖点生成 3 个 before/after 概念
// body: { productInfo: {...}, sellingPoints: [{title, detail}] }
router.post('/concepts', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const sellingPoints = Array.isArray(req.body.sellingPoints) ? req.body.sellingPoints : []
    if (sellingPoints.length === 0) {
      return res.status(400).json({ error: '请先选择至少一个卖点' })
    }
    const concepts = await generateBeforeAfterConcepts({
      sellingPoints,
      productInfo: req.body.productInfo || {},
      userIdea: req.body.userIdea || '',
    })
    res.json({ concepts })
  } catch (e) {
    console.error('[before-after] 生成概念失败:', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default router
