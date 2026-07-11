const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const https = require('https');
const { randomUUID } = require('crypto');

const { convertDocOrDocxToCleanDocx } = require('./convertLegacyDoc');
const { extractAndConvertEquations } = require('./extractEquations');

const app = express();
const PORT = process.env.PORT || 8787;

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(docx?|DOCX?)$/i.test(file.originalname);
    if (!ok) return cb(new Error('Only .doc and .docx files are supported'));
    cb(null, true);
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'examsetu-doc-convert' }));

// ── Claude API proxy ──────────────────────────────────────────────────────────
// Browser cannot call api.anthropic.com directly due to CORS.
// This endpoint forwards the request server-side where CORS doesn't apply.
// Set ANTHROPIC_API_KEY as an environment variable in Render dashboard.
app.post('/api/claude-proxy', express.json({ limit: '4mb' }), (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on server. Add it in Render → Environment.' });
  }
  const body = JSON.stringify(req.body);
  const options = {
    hostname: 'api.anthropic.com',
    port: 443,
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey
    }
  };
  const proxyReq = https.request(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => {
      res.status(proxyRes.statusCode).set('Content-Type', 'application/json').send(data);
    });
  });
  proxyReq.on('error', err => res.status(500).json({ error: err.message }));
  proxyReq.write(body);
  proxyReq.end();
});

// ── DOC/DOCX equation conversion ─────────────────────────────────────────────
app.post('/convert-equations', upload.single('file'), async (req, res) => {
  const jobId = randomUUID();
  const workDir = path.join(os.tmpdir(), 'examsetu-' + jobId);
  if (!req.file) return res.status(400).json({ error: 'No file uploaded. Use field name "file".' });
  try {
    await fs.mkdir(workDir, { recursive: true });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const inputPath = path.join(workDir, 'input' + ext);
    await fs.writeFile(inputPath, req.file.buffer);
    const docxPath = await convertDocOrDocxToCleanDocx(inputPath, workDir);
    const result = await extractAndConvertEquations(docxPath, workDir);
    res.json(result);
  } catch (err) {
    console.error('[convert-equations] failed:', err);
    res.status(500).json({ error: 'Conversion failed', detail: String(err.message || err) });
  } finally {
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message?.includes('Only .doc')) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error' });
});

app.listen(PORT, () => {
  console.log(`ExamSetu doc-convert backend listening on port ${PORT}`);
});
