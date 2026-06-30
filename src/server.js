const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const { randomUUID } = require('crypto');

const { convertDocOrDocxToCleanDocx } = require('./convertLegacyDoc');
const { extractAndConvertEquations } = require('./extractEquations');

const app = express();
const PORT = process.env.PORT || 8799;

// In production, set ALLOWED_ORIGIN to your ExamSetu domain (see README "Security notes").
// Left permissive by default so this works immediately during setup/testing.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB cap — typical test papers are 1-5MB
  fileFilter: (req, file, cb) => {
    const ok = /\.(docx?|DOCX?)$/i.test(file.originalname);
    if (!ok) return cb(new Error('Only .doc and .docx files are supported'));
    cb(null, true);
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'examsetu-doc-convert' }));

/**
 * POST /convert-equations
 * Body: multipart/form-data, field name "file" — a .doc or .docx
 *
 * Returns: {
 *   text: "<extracted text with [[EQIMG:n]] / [[IMG:n]] placeholder tokens inline>",
 *   equations: [{ id, dataUrl }],   // base64 PNG, trimmed
 *   images: [{ id, dataUrl }]       // diagrams/figures, base64
 * }
 *
 * The ExamSetu frontend already knows how to run its own text+structure parser
 * (parseQuestionsFromText) on plain text — this endpoint's ONLY job is to turn
 * the un-parseable parts (WMF/OLE equation objects, embedded diagrams) into
 * inline image placeholders so nothing is silently dropped.
 */
app.post('/convert-equations', upload.single('file'), async (req, res) => {
  const jobId = randomUUID();
  const workDir = path.join(os.tmpdir(), 'examsetu-' + jobId);

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Use field name "file".' });
  }

  try {
    await fs.mkdir(workDir, { recursive: true });

    const ext = path.extname(req.file.originalname).toLowerCase();
    const inputPath = path.join(workDir, 'input' + ext);
    await fs.writeFile(inputPath, req.file.buffer);

    // Step 1: If it's a legacy .doc, convert to .docx first (LibreOffice headless).
    // .docx files pass through untouched.
    const docxPath = await convertDocOrDocxToCleanDocx(inputPath, workDir);

    // Step 2: Walk the docx, extract text + convert every WMF/OLE equation and
    // every embedded image to a trimmed PNG data URL, inline placeholder tokens
    // in the text so the frontend parser can match them back to the right question.
    const result = await extractAndConvertEquations(docxPath, workDir);

    res.json(result);
  } catch (err) {
    console.error('[convert-equations] failed:', err);
    res.status(500).json({ error: 'Conversion failed', detail: String(err.message || err) });
  } finally {
    // Best-effort cleanup — don't let cleanup errors affect the response
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
