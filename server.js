// server.js — Gemini Proxy + MongoDB Voter Audit API
// Run: npm install pdf-lib   (one time)
// Then: node server.js
// Then in another terminal: npm run dev

const express         = require('express')
const cors            = require('cors')
const https           = require('https')
const { MongoClient } = require('mongodb')
const { ObjectId } = require('mongodb')

const app  = express()
const PORT = 3001

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const MONGO_URI  =  'mongodb+srv://Voter-List:Voter-List@voter-list.hx0pqbh.mongodb.net'
const DB_NAME    = process.env.DB_NAME    || 'test'
const COLLECTION = process.env.COLLECTION || 'voters'
// ─────────────────────────────────────────────────────────────────────────────

app.use(cors({
  origin: ['https://anthropic-extracting.vercel.app', 'http://localhost:5173'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-api-key'],
  credentials: true,  // If you're using cookies/auth
  exposedHeaders: ['Content-Type'],  // For SSE
}))
app.use(express.json({ limit: '200mb' }))

// ─── DB helper ────────────────────────────────────────────────────────────────
async function getDb() {
  const client = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
  })
  await client.connect()
  return { client, col: client.db(DB_NAME).collection(COLLECTION) }
}

// ─── Allowed fields for UPDATE ────────────────────────────────────────────────
const ALLOWED_UPDATE = new Set([
  'nameMl', 'nameEn', 'age', 'gender',
  'relationType', 'relationNameMl', 'relationNameEn',
  'houseMl','boothId', 'houseEn', 'slNo',
])

// ─── Allowed fields for INSERT (PDF-only new voters) ─────────────────────────
const ALLOWED_INSERT = new Set([
  'voterId', 'slNo', 'nameMl', 'nameEn', 'age', 'gender',
  'relationType', 'relationNameMl', 'relationNameEn',
  'houseMl','boothId', 'houseEn', 'auditStatus', 'lastAuditedAt', 'createdAt',
])

function sanitizeUpdate(fields) {
  const safe = {}, rejected = []
  for (const [k, v] of Object.entries(fields)) {
    if (ALLOWED_UPDATE.has(k)) safe[k] = k === 'age' ? (parseInt(v) || v) : String(v).trim()
    else rejected.push(k)
  }
  return { safe, rejected }
}

// function sanitizeInsert(record) {
//   const safe = {}
//   for (const [k, v] of Object.entries(record)) {
//     if (ALLOWED_INSERT.has(k) && v !== undefined && v !== null && v !== '') {
//       safe[k] = k === 'age' ? (parseInt(v) || v) : typeof v === 'string' ? v.trim() : v
//     }
//   }
//   return safe
// }
function sanitizeInsert(record) {
  const safe = {}

  for (const [k, v] of Object.entries(record)) {
    if (ALLOWED_INSERT.has(k) && v !== undefined && v !== null && v !== '') {

      if (k === 'age') {
        safe[k] = parseInt(v) || v

      } else if (k === 'boothId') {
        // 🔥 CONVERT HERE
        try {
          safe[k] = new ObjectId(v)
        } catch {
          console.warn("⚠️ Invalid boothId:", v)
        }

      } else {
        safe[k] = typeof v === 'string' ? v.trim() : v
      }
    }
  }

  return safe
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  let mongoStatus = 'ERROR ❌'
  let allDatabases = []
  let voterCount = null
  let errorMsg = null
  try {
    const { client, col } = await getDb()
    await client.db().admin().command({ ping: 1 })
    mongoStatus = 'connected ✅'
    const list = await client.db().admin().listDatabases()
    allDatabases = list.databases.map(d => `${d.name} (${d.sizeOnDisk} bytes)`)
    voterCount = await col.countDocuments()
    await client.close()
  } catch (err) {
    errorMsg = err.message
  }
  res.json({ server: 'running ✅', mongo: mongoStatus, voterCount, allDatabases, error: errorMsg })
})

// ─── DEBUG: list first 10 voters ──────────────────────────────────────────────
app.get('/api/voters', async (_req, res) => {
  let client
  try {
    const conn = await getDb(); client = conn.client
    const voters = await conn.col.find({}).limit(10)
      .project({ voterId: 1, nameEn: 1, boothId: 1, auditStatus: 1, _id: 0 }).toArray()
    const total = await conn.col.countDocuments()
    res.json({ total, sample: voters })
  } catch (err) {
    res.status(500).json({ error: err.message })
  } finally {
    if (client) await client.close()
  }
})


//─── ANTHROPIC PROXY (fixes CORS) ────────────────────────────────────────────
// app.post('/api/anthropic', (req, res) => {
//   const apiKey = req.headers['x-api-key']
//   if (!apiKey) return res.status(400).json({ error: 'Missing x-api-key header' })

//   const body = JSON.stringify(req.body)
//   const opts = {
//     hostname: 'api.anthropic.com',
//     path:     '/v1/messages',
//     method:   'POST',
//     headers: {
//       'Content-Type':      'application/json',
//       'Content-Length':    Buffer.byteLength(body),
//       'x-api-key':         apiKey,
//       'anthropic-version': '2023-06-01',
//     },
//   }

//   const pr = https.request(opts, (upstream) => {
//     res.status(upstream.statusCode).setHeader('Content-Type', 'application/json')
//     let data = ''
//     upstream.on('data', c => { data += c })
//     upstream.on('end', () => res.send(data))
//   })
//   pr.on('error', err => res.status(500).json({ error: err.message }))
//   pr.write(body)
//   pr.end()
// })









// ─── PDF SPLIT HELPER (server-side using pdf-lib) ────────────────────────────
async function splitPdfBase64(base64Pdf, chunkSize) {
  let PDFDocument
  try {
    PDFDocument = require('pdf-lib').PDFDocument
  } catch {
    console.warn('⚠️  pdf-lib not installed. Run: npm install pdf-lib')
    console.warn('⚠️  Falling back to single-chunk (will miss pages beyond limit)')
    return [base64Pdf]
  }

  const pdfBytes = Buffer.from(base64Pdf, 'base64')
  const srcDoc = await PDFDocument.load(pdfBytes)
  const totalPages = srcDoc.getPageCount()
  console.log(`📄 PDF has ${totalPages} pages, splitting into chunks of ${chunkSize}`)

  const chunks = []
  const START_PAGE = 2
  for (let start = START_PAGE; start < totalPages; start += chunkSize) {
    const end = Math.min(start + chunkSize, totalPages)
    const newDoc = await PDFDocument.create()
    const indices = Array.from({ length: end - start }, (_, i) => start + i)
    const pages = await newDoc.copyPages(srcDoc, indices)
    pages.forEach(p => newDoc.addPage(p))
    const bytes = await newDoc.save()
    chunks.push(Buffer.from(bytes).toString('base64'))
    console.log(`  ✓ Chunk ${chunks.length}: pages ${start + 1}–${end}`)
  }
  return chunks
}

// ─── GEMINI CALL HELPER ───────────────────────────────────────────────────────
function callGemini(apiKey, model, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body)
    const opts = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }
    const req = https.request(opts, (upstream) => {
      let data = ''
      upstream.on('data', c => { data += c })
      upstream.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('Invalid JSON from Gemini')) }
      })
    })
    req.on('error', reject)
    req.write(bodyStr)
    req.end()
  })
}

// ─── EXTRACT VOTERS FROM ONE CHUNK ───────────────────────────────────────────
async function extractChunk(base64Chunk, apiKey, model, chunkIdx, totalChunks) {
  const prompt = `Extract ALL voter records from this Kerala Electoral Roll PDF (Malayalam text).
Each voter card has: serial number, voter ID (e.g. UAZ..., MST..., LJG..., HVK..., DLL..., etc.),
name in Malayalam (പേര്), relation type (Father=അച്ഛൻ/Husband=ഭർത്താവ്/Mother=അമ്മ),
relation name in Malayalam, house number/name, age (പ്രായം), gender.

This is chunk ${chunkIdx + 1} of ${totalChunks}. Extract EVERY voter card visible — do not skip any.
Gender: "Male" or "Female" based on column position (left column = Male, right column = Female).
Transliterate ALL Malayalam text to English for nameEn, houseEn, relationNameEn fields.

Return ONLY a raw JSON array (no markdown, no backticks, no explanation):`

  const result = await callGemini(apiKey, model, {
    contents: [{
      parts: [
        { inline_data: { mime_type: 'application/pdf', data: base64Chunk } },
        { text: prompt },
      ],
    }],
    generationConfig: { maxOutputTokens: 32000, temperature: 0 },
  })

  if (result.error) throw new Error(`Gemini chunk ${chunkIdx + 1}: ${result.error.message}`)

  const text = result.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? ''
  const clean = text.replace(/```json[\s\S]*?```|```/g, '').trim()

  try {
    return JSON.parse(clean)
  } catch {
    const lastComma = clean.lastIndexOf('},')
    if (lastComma > 0) {
      try {
        return JSON.parse((clean.startsWith('[') ? '' : '[') + clean.slice(0, lastComma + 1) + ']')
      } catch { /* fall through */ }
    }
    console.warn(`Chunk ${chunkIdx + 1} JSON parse failed — skipping`)
    return []
  }
}

// ─── EXTRACT PDF — chunked, SSE progress stream ───────────────────────────────
// POST /api/extract-pdf
// Body: { base64Pdf, apiKey, model?, chunkSize? }
// Streams Server-Sent Events: { type: 'progress'|'done'|'error'|'warning', msg, pct, voters? }
app.post('/api/extract-pdf', async (req, res) => {
  const { base64Pdf, apiKey, model = 'gemini-2.5-flash', chunkSize = 10 } = req.body
  if (!base64Pdf) return res.status(400).json({ error: 'Missing base64Pdf' })
  if (!apiKey)    return res.status(400).json({ error: 'Missing apiKey' })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`)

  try {
    send('progress', { msg: 'Splitting PDF into chunks on server...', pct: 5 })
    const chunks = await splitPdfBase64(base64Pdf, chunkSize)
    send('progress', { msg: `PDF has ${chunks.length} chunk(s) of ~${chunkSize} pages each. Extracting...`, pct: 10 })

    const allRecords = []
    const seenIds = new Set()

    for (let i = 0; i < chunks.length; i++) {
      const pct = 10 + Math.round((i / chunks.length) * 72)
      send('progress', {
        msg: `Extracting chunk ${i + 1} / ${chunks.length}  (pages ${i * chunkSize + 1}–${Math.min((i + 1) * chunkSize, chunks.length * chunkSize)})...`,
        pct,
      })

      try {
        const records = await extractChunk(chunks[i], apiKey, model, i, chunks.length)
        let added = 0
        for (const r of records) {
          if (r.voterId && !seenIds.has(r.voterId)) {
            seenIds.add(r.voterId)
            allRecords.push(r)
            added++
          }
        }
        send('progress', {
          msg: `Chunk ${i + 1}/${chunks.length} ✓  +${added} voters  (total: ${allRecords.length})`,
          pct: pct + Math.round(72 / chunks.length),
        })
      } catch (err) {
        send('warning', { msg: `Chunk ${i + 1} failed: ${err.message} — continuing` })
      }
    }

    send('done', {
      voters:         allRecords,
      totalChunks:    chunks.length,
      totalExtracted: allRecords.length,
      msg:  `✓ Extraction complete — ${allRecords.length} voters from ${chunks.length} chunk(s)`,
      pct:  85,
    })
  } catch (err) {
    send('error', { msg: err.message })
  } finally {
    res.end()
  }
})

// ─── GEMINI PROXY (pass-through) ─────────────────────────────────────────────
app.post('/api/gemini', (req, res) => {
  const apiKey = req.headers['x-api-key']
  if (!apiKey) return res.status(400).json({ error: 'Missing x-api-key header' })
  const { model = 'gemini-2.5-flash', ...body } = req.body
  const bodyStr = JSON.stringify(body)
  const opts = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
  }
  const pr = https.request(opts, (upstream) => {
    res.status(upstream.statusCode).setHeader('Content-Type', 'application/json')
    let data = ''
    upstream.on('data', c => { data += c })
    upstream.on('end', () => res.send(data))
  })
  pr.on('error', err => res.status(500).json({ error: err.message }))
  pr.write(bodyStr)
  pr.end()
})

// ─── SINGLE UPDATE ────────────────────────────────────────────────────────────
app.post('/api/update-voter', async (req, res) => {
  const { voterId, fields } = req.body
  if (!voterId) return res.status(400).json({ error: 'Missing voterId' })
  if (!fields || !Object.keys(fields).length) return res.status(400).json({ error: 'Missing fields' })
  const { safe, rejected } = sanitizeUpdate(fields)
  if (!Object.keys(safe).length) return res.status(400).json({ error: 'No allowed fields', rejected })
  let client
  try {
    const conn = await getDb(); client = conn.client
    const result = await conn.col.updateOne(
      { voterId },
      { $set: { ...safe, auditStatus: 'corrected', lastAuditedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }
    )
    if (result.matchedCount === 0) return res.status(404).json({ error: `Voter not found: ${voterId}` })
    console.log(`✅ Updated ${voterId}`)
    res.json({ success: true, voterId, modifiedCount: result.modifiedCount, updatedFields: Object.keys(safe), rejectedFields: rejected })
  } catch (err) {
    res.status(500).json({ error: err.message })
  } finally {
    if (client) await client.close()
  }
})

// ─── SINGLE INSERT (PDF-only voter — skip if already exists by voterId) ───────
app.post('/api/insert-voter', async (req, res) => {
  const { record } = req.body
  if (!record || !record.voterId) return res.status(400).json({ error: 'Missing record or voterId' })
  const safe = sanitizeInsert(record)
  if (!safe.voterId) return res.status(400).json({ error: 'voterId required' })
  let client
  try {
    const conn = await getDb(); client = conn.client
    const existing = await conn.col.findOne({ voterId: safe.voterId })
    if (existing) {
      return res.json({ success: true, voterId: safe.voterId, inserted: false, message: 'Already exists — skipped' })
    }
    await conn.col.insertOne(safe)
    console.log(`✅ Inserted ${safe.voterId} — ${safe.nameEn}`)
    res.json({ success: true, voterId: safe.voterId, inserted: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  } finally {
    if (client) await client.close()
  }
})

// ─── BULK UPDATE + INSERT ─────────────────────────────────────────────────────
// updates: [{voterId, fields}]  — mismatch corrections
// inserts: [{voterId, ...}]     — PDF-only new voters (skipped if voterId already in DB)
app.post('/api/update-voters-bulk', async (req, res) => {
  const { updates = [], inserts = [] } = req.body
  if (!updates.length && !inserts.length)
    return res.status(400).json({ error: 'No updates or inserts provided' })

  let client
  try {
    const conn = await getDb(); client = conn.client; const col = conn.col
    let updateSuccess = 0, notFound = 0, updateFailed = 0
    let insertSuccess = 0, insertSkipped = 0, insertFailed = 0
    const errors = []

    for (const { voterId, fields } of updates) {
      if (!voterId || !fields) { updateFailed++; errors.push({ voterId, error: 'Missing fields' }); continue }
      const { safe } = sanitizeUpdate(fields)
      if (!Object.keys(safe).length) continue
      try {
        const r = await col.updateOne(
          { voterId },
          { $set: { ...safe, auditStatus: 'corrected', lastAuditedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }
        )
        r.matchedCount === 0 ? (notFound++, errors.push({ voterId, error: 'Not found' })) : updateSuccess++
      } catch (e) { updateFailed++; errors.push({ voterId, error: e.message }) }
    }

    for (const record of inserts) {
      const safe = sanitizeInsert(record)
      if (!safe.voterId) continue
      try {
        const existing = await col.findOne({ voterId: safe.voterId })
        if (existing) {
          console.log("Updating voter:", record.voterId, "→ boothId:", record.boothId)
          insertSkipped++; continue }
//         if (existing) {
//   console.log("🔁 Updating voter:", record.voterId, "→ boothId:", record.boothId)

//   if (!record.boothId) {
//     console.warn("⚠️ Missing boothId for", record.voterId)
//     insertSkipped++
//     continue
//   }

//   await col.updateOne(
//     { voterId: safe.voterId },
//     {
//       $set: {
//         boothId: new ObjectId(record.boothId),boothId: safe.boothId || new ObjectId(record.boothId),// 🔥 CRITICAL
//         slNo: safe.slNo || existing.slNo,
//         updatedAt: new Date().toISOString()
//       }
//     }
//   )

//   insertSkipped++
//   continue
// }
        await col.insertOne(safe)
        insertSuccess++
      } catch (e) { insertFailed++; errors.push({ voterId: record.voterId, error: e.message }) }
    }

    console.log(`✅ Bulk — updated:${updateSuccess} notFound:${notFound} inserted:${insertSuccess} skipped:${insertSkipped}`)
    res.json({
      success: true,
      successCount:  updateSuccess,
      notFoundCount: notFound,
      errorCount:    updateFailed + insertFailed,
      insertedCount: insertSuccess,
      skippedCount:  insertSkipped,
      totalSent:     updates.length + inserts.length,
      errors:        errors.slice(0, 20),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  } finally {
    if (client) await client.close()
  }
})


app.post('/api/check-voter', async (req, res) => {
  const { voterId } = req.body

  if (!voterId) {
    return res.status(400).json({ error: 'Missing voterId' })
  }

  let client
  try {
    const conn = await getDb()
    client = conn.client

    const voter = await conn.col.findOne({ voterId })

    if (voter) {
      return res.json({
        exists: true,
        boothId: voter.boothId
      })
    }

    return res.json({ exists: false })

  } catch (err) {
    res.status(500).json({ error: err.message })
  } finally {
    if (client) await client.close()
  }
})

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║        Voter Audit Proxy Server — http://localhost:${PORT}  ║
╚══════════════════════════════════════════════════════════╝

  MongoDB   : ${MONGO_URI.replace(/:\/\/([^:@]+:[^@]+)@/, '://***@')}
  Database  : ${DB_NAME}
  Collection: ${COLLECTION}

  Endpoints:
  GET  /api/health              → Check MongoDB connection
  GET  /api/voters              → Preview first 10 voters
  POST /api/extract-pdf         → Chunked PDF → Gemini (SSE stream)
  POST /api/gemini              → Gemini pass-through proxy
  POST /api/update-voter        → Update single mismatch voter
  POST /api/insert-voter        → Insert single PDF-only voter (skips if exists)
  POST /api/update-voters-bulk  → Bulk: update mismatches + insert missing

`)
})