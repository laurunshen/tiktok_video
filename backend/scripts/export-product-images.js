/**
 * 导出产品素材图到本地文件夹
 * 用法：node backend/scripts/export-product-images.js [productId]
 *
 * 不传 productId 则列出所有产品让你选
 */

import '../load-env.js'
import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'
import { pool } from '../services/db.js'

// ── 工具函数 ──────────────────────────────────────────────

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const client = url.startsWith('https') ? https : http
    client.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close()
        fs.unlinkSync(dest)
        return download(res.headers.location, dest).then(resolve).catch(reject)
      }
      if (res.statusCode !== 200) {
        file.close()
        fs.unlinkSync(dest)
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }
      res.pipe(file)
      file.on('finish', () => file.close(resolve))
    }).on('error', (e) => {
      fs.unlinkSync(dest)
      reject(e)
    })
  })
}

function ext(url) {
  const u = url.split('?')[0]
  const m = u.match(/\.(jpg|jpeg|png|webp|gif)$/i)
  return m ? m[0].toLowerCase() : '.jpg'
}

// ── 主逻辑 ───────────────────────────────────────────────

async function main() {
  const argId = process.argv[2]

  // 查所有产品
  const { rows: products } = await pool.query(
    `SELECT product_id, name, main_image_urls, detail_image_urls, user_image_urls
     FROM products ORDER BY last_used_at DESC`
  )

  if (products.length === 0) {
    console.log('数据库里没有产品记录。')
    process.exit(0)
  }

  // 列出产品
  let target
  if (argId) {
    target = products.find(p => p.product_id === argId)
    if (!target) {
      console.log(`找不到 productId=${argId}`)
      console.log('现有产品：')
      products.forEach(p => console.log(`  ${p.product_id}  ${p.name || '(无名)'}`))
      process.exit(1)
    }
  } else {
    console.log('\n现有产品列表：\n')
    products.forEach((p, i) => {
      const main  = JSON.parse(p.main_image_urls  || '[]').length
      const detail= JSON.parse(p.detail_image_urls|| '[]').length
      const user  = JSON.parse(p.user_image_urls  || '[]').length
      console.log(`  [${i}] ${p.product_id}`)
      console.log(`       名称：${p.name || '(无名)'}`)
      console.log(`       主图 ${main} 张 | 细节图 ${detail} 张 | 自定义图 ${user} 张\n`)
    })
    console.log('请重新运行并传入 productId，例如：')
    console.log(`  node backend/scripts/export-product-images.js ${products[0].product_id}`)
    process.exit(0)
  }

  // 收集所有 URL
  const groups = {
    main:   JSON.parse(target.main_image_urls   || '[]'),
    detail: JSON.parse(target.detail_image_urls || '[]'),
    user:   JSON.parse(target.user_image_urls   || '[]'),
  }

  const total = groups.main.length + groups.detail.length + groups.user.length
  console.log(`\n产品：${target.name || target.product_id}`)
  console.log(`主图 ${groups.main.length} 张 | 细节图 ${groups.detail.length} 张 | 自定义图 ${groups.user.length} 张`)
  console.log(`共 ${total} 张\n`)

  // 创建输出目录
  const outDir = path.join(process.cwd(), 'exports', target.product_id)
  fs.mkdirSync(outDir, { recursive: true })
  console.log(`保存到：${outDir}\n`)

  // 下载
  let ok = 0, fail = 0
  for (const [group, urls] of Object.entries(groups)) {
    if (urls.length === 0) continue
    const groupDir = path.join(outDir, group)
    fs.mkdirSync(groupDir, { recursive: true })

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]
      const filename = `${String(i + 1).padStart(2, '0')}${ext(url)}`
      const dest = path.join(groupDir, filename)
      process.stdout.write(`  [${group}] ${filename} ... `)
      try {
        await download(url, dest)
        console.log('✓')
        ok++
      } catch (e) {
        console.log(`✗ ${e.message}`)
        fail++
      }
    }
  }

  console.log(`\n完成：成功 ${ok} 张，失败 ${fail} 张`)
  console.log(`文件夹：${outDir}`)
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
