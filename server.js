const express = require('express')
const cors = require('cors')
const multer = require('multer')
const mysql = require('mysql2/promise')
const COS = require('cos-nodejs-sdk-v5')
const crypto = require('crypto')

const app = express()
const PORT = Number(process.env.PORT || 8080)
const APPID = process.env.WX_APPID || 'wx504c106474975d60'
const WX_SECRET = process.env.WX_SECRET || ''
const pool = process.env.MYSQL_ADDRESS ? mysql.createPool({
  host: process.env.MYSQL_ADDRESS,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USERNAME || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'blind_help',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4'
}) : null

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } })
const cos = process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY && process.env.COS_BUCKET && process.env.COS_REGION
  ? new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY }) : null

app.use(cors({ origin: true, credentials: false }))
app.use(express.json({ limit: '1mb' }))

const now = () => new Date()
const id = () => `HELP${Date.now().toString().slice(-8)}${crypto.randomBytes(2).toString('hex').toUpperCase()}`
const memoryOrders = []
const memoryLogs = []

async function initDb() {
  if (!pool) return
  await pool.query(`CREATE TABLE IF NOT EXISTS help_orders (
    id VARCHAR(40) PRIMARY KEY,
    status VARCHAR(20) NOT NULL DEFAULT 'waiting',
    content TEXT,
    station VARCHAR(100) DEFAULT '',
    user_name VARCHAR(100) DEFAULT '',
    openid VARCHAR(100) DEFAULT '',
    audio_url TEXT,
    assignee VARCHAR(100) DEFAULT '',
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    INDEX idx_status(status), INDEX idx_created(created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  await pool.query(`CREATE TABLE IF NOT EXISTS help_logs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_id VARCHAR(40) NOT NULL,
    action VARCHAR(30) NOT NULL,
    operator VARCHAR(100) DEFAULT '',
    details TEXT,
    created_at DATETIME NOT NULL,
    INDEX idx_order(order_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

function toOrder(row) {
  if (!row) return row
  return { id: row.id, status: row.status, content: row.content || '', station: row.station || '', userName: row.user_name || row.userName || '', openid: row.openid || '', audioUrl: row.audio_url || row.audioUrl || '', assignee: row.assignee || '', createdAt: row.created_at || row.createdAt, updatedAt: row.updated_at || row.updatedAt }
}
async function listOrders() {
  if (!pool) return memoryOrders.map(toOrder).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))
  const [rows] = await pool.query('SELECT * FROM help_orders ORDER BY created_at DESC LIMIT 500')
  return rows.map(toOrder)
}
async function findOrder(orderId) {
  if (!pool) return memoryOrders.find(x => x.id === orderId)
  const [rows] = await pool.query('SELECT * FROM help_orders WHERE id=? LIMIT 1', [orderId])
  return rows[0]
}
async function log(orderId, action, operator, details = '') {
  const item = { orderId, action, operator, details, createdAt: now() }
  if (!pool) return memoryLogs.push(item)
  await pool.query('INSERT INTO help_logs(order_id,action,operator,details,created_at) VALUES(?,?,?,?,?)', [orderId, action, operator, JSON.stringify(details), now()])
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'blind-help-backend', time: now().toISOString(), database: Boolean(pool) }))
app.get('/', (req, res) => res.json({ name: 'blind-help-backend', endpoints: ['GET /help-orders', 'POST /help-orders', 'PUT /help-orders/:id/status', 'POST /help-orders/:id/audio'] }))

app.get('/help-orders', async (req, res) => {
  try { res.json({ success: true, data: await listOrders() }) } catch (e) { console.error(e); res.status(500).json({ success: false, error: '读取工单失败' }) }
})

app.post('/help-orders', async (req, res) => {
  const body = req.body || {}
  const order = { id: body.id || id(), status: 'waiting', content: body.content || '语音求助（待识别）', station: body.station || '', user_name: body.userName || '', openid: body.openid || '', audio_url: body.audioUrl || '', assignee: '', created_at: now(), updated_at: now() }
  try {
    if (pool) await pool.query('INSERT INTO help_orders SET ?', order)
    else memoryOrders.unshift(order)
    await log(order.id, 'created', body.userName || '小程序用户')
    res.status(201).json({ success: true, data: toOrder(order) })
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: '创建工单失败' }) }
})

app.put('/help-orders/:id/status', async (req, res) => {
  const allowed = ['waiting', 'assigned', 'arrived', 'completed', 'cancelled']
  const next = req.body && req.body.status
  if (!allowed.includes(next)) return res.status(400).json({ success: false, error: '无效工单状态' })
  try {
    const existing = await findOrder(req.params.id)
    if (!existing) return res.status(404).json({ success: false, error: '工单不存在' })
    const operator = req.body.operator || '调度员'
    if (pool) await pool.query('UPDATE help_orders SET status=?, assignee=?, updated_at=? WHERE id=?', [next, next === 'assigned' ? operator : (existing.assignee || ''), now(), req.params.id])
    else { existing.status = next; existing.assignee = next === 'assigned' ? operator : existing.assignee; existing.updated_at = now() }
    await log(req.params.id, `status_${next}`, operator, req.body)
    res.json({ success: true, data: toOrder(await findOrder(req.params.id)) })
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: '更新工单失败' }) }
})

app.post('/help-orders/:id/audio', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: '缺少 audio 文件' })
  try {
    const existing = await findOrder(req.params.id)
    if (!existing) return res.status(404).json({ success: false, error: '工单不存在' })
    if (!cos) return res.status(503).json({ success: false, error: 'COS 未配置，暂不能上传音频' })
    const Key = `help-orders/${req.params.id}/${Date.now()}-${req.file.originalname || 'audio.mp3'}`
    const result = await cos.putObject({ Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key, Body: req.file.buffer, ContentType: req.file.mimetype || 'audio/mpeg' })
    const audioUrl = `https://${result.Location}`
    if (pool) await pool.query('UPDATE help_orders SET audio_url=?, updated_at=? WHERE id=?', [audioUrl, now(), req.params.id])
    else { existing.audio_url = audioUrl; existing.updated_at = now() }
    await log(req.params.id, 'audio_uploaded', '小程序', { audioUrl })
    res.json({ success: true, audioUrl })
  } catch (e) { console.error(e); res.status(500).json({ success: false, error: '音频上传失败' }) }
})

app.get('/help-orders/:id/logs', async (req, res) => {
  try {
    if (!pool) return res.json({ success: true, data: memoryLogs.filter(x => x.orderId === req.params.id) })
    const [rows] = await pool.query('SELECT * FROM help_logs WHERE order_id=? ORDER BY created_at DESC', [req.params.id])
    res.json({ success: true, data: rows })
  } catch (e) { res.status(500).json({ success: false, error: '读取日志失败' }) }
})

app.post('/auth/wx-login', async (req, res) => {
  const code = req.body && req.body.code
  if (!code) return res.status(400).json({ success: false, error: '缺少微信 code' })
  if (!WX_SECRET) return res.status(503).json({ success: false, error: 'WX_SECRET 未配置' })
  try {
    const r = await fetch(`https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(APPID)}&secret=${encodeURIComponent(WX_SECRET)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`)
    const data = await r.json()
    if (data.errcode) return res.status(401).json({ success: false, error: data.errmsg || '微信登录失败' })
    res.json({ success: true, openid: data.openid, unionid: data.unionid || '' })
  } catch (e) { res.status(502).json({ success: false, error: '微信登录接口不可用' }) }
})

// Start server immediately, init DB in background
app.listen(PORT, () => console.log(`blind-help-backend listening on ${PORT}`))

initDb().then(() => {
  console.log('Database initialized successfully')
}).catch(err => {
  console.error('DB init failed, will retry:', err.message)
  // Retry DB init every 30 seconds
  setInterval(() => {
    initDb().then(() => console.log('Database initialized on retry')).catch(e => console.error('DB retry failed:', e.message))
  }, 30000)
})