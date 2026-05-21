import express from 'express'
import { listTemplates, saveTemplate, updateTemplate, deleteTemplate } from '../services/db.js'

const router = express.Router()
router.use(express.json())

router.get('/', async (req, res) => {
  try {
    const rows = await listTemplates()
    res.json({ templates: rows })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/', async (req, res) => {
  try {
    const row = await saveTemplate(req.body)
    res.json({ template: row })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.patch('/:id', async (req, res) => {
  try {
    const row = await updateTemplate(Number(req.params.id), req.body)
    res.json({ template: row })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const ok = await deleteTemplate(Number(req.params.id))
    res.json({ ok })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
