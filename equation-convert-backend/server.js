// ExamSetu — DOCX equation/diagram conversion backend
//
// Job: given an uploaded .docx that contains legacy Equation Editor / MathType
// equations (embedded as OLE objects with WMF/EMF vector previews — these CANNOT
// be rendered by a browser <img> tag no matter what MIME type you give them),
// convert each one to a real, small, tightly-cropped PNG using LibreOffice
// headless, and return paragraph text with [[EQIMG:n]]/[[IMG:n]] placeholders
// plus the matching PNG data-urls — in exactly the shape examsetu-v19.html
// already expects from DOC_CONVERT_BACKEND_URL + '/convert-equations':
//
//   { text: "...", equations: [{id, dataUrl}], images: [{id, dataUrl}],
//     stats: { totalEquations, failedEquations, totalImages, failedImages } }
//
// Requires LibreOffice ("soffice") on PATH — see Dockerfile for deployment.

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const JSZip = require('jszip');
const sharp = require('sharp');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 4000;
const app = express();
app.use(cors());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

app.get('/', (req, res) => res.json({ ok: true, service: 'examsetu-doc-convert' }));
app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// ── WMF/EMF -> tightly-cropped PNG, batched through LibreOffice headless ──
// LibreOffice renders each metafile onto a full page canvas (mostly whitespace),
// so we auto-trim the uniform background afterwards with sharp — otherwise every
// equation would show as a mostly-blank near-A4-sized image inline in the text.
//
// IMPORTANT — do not convert one file per soffice process for real exam papers:
// each `soffice --convert-to` invocation pays LibreOffice's own startup cost
// (~1s), so a paper with hundreds of equations (a real full-length JEE test can
// have 300-400+) would take minutes and blow past any HTTP/server timeout.
// Passing MANY files to a single soffice invocation is much faster per-file,
// but testing against a real 388-equation exam docx showed conversion silently
// plateaus at exactly ~248 output files no matter the timeout given — some
// internal LibreOffice limit, not a timeout artifact (reproduced twice, exact
// same count, different batch compositions). Fix: chunk into batches of 50 —
// safely under that ceiling and still gets nearly all of the batching speedup.
const CHUNK_SIZE = 50;

function runSoffice(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('soffice', args, { cwd, timeout: 90000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Convert a whole batch of {rId, buffer, ext} at once. Returns { rId: dataUrl }
// for everything that converted successfully; anything that failed is simply
// absent from the result (caller treats a missing rId as a failed conversion).
async function batchConvertWmf(items) {
  if (!items.length) return {};
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eqbatch-'));
  const result = {};
  try {
    // Give every file a unique, collision-proof name (rId strings can repeat
    // across differently-named relationship files, so index instead).
    const nameFor = (i, ext) => `f${i}.${ext}`;
    items.forEach((it, i) => {
      fs.writeFileSync(path.join(tmpDir, nameFor(i, it.ext)), it.buffer);
    });

    for (const batch of chunk(items.map((it, i) => ({ ...it, idx: i })), CHUNK_SIZE)) {
      const files = batch.map((it) => nameFor(it.idx, it.ext));
      try {
        await runSoffice(['--headless', '--convert-to', 'png', '--outdir', tmpDir, ...files], tmpDir);
      } catch (e) {
        console.warn('Batch conversion chunk failed (continuing with next chunk):', e.message);
      }
      for (const it of batch) {
        const outPath = path.join(tmpDir, `f${it.idx}.png`);
        if (!fs.existsSync(outPath)) continue; // this one failed — leave unresolved
        try {
          const buf = await sharp(outPath).trim({ background: '#ffffff', threshold: 10 }).png().toBuffer();
          result[it.rId] = 'data:image/png;base64,' + buf.toString('base64');
        } catch (e) {
          console.warn('Post-process (trim/encode) failed for', it.rId, e.message);
        }
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return result;
}

// ── DOCX paragraph/text extraction (same approach as the client-side fallback in
// examsetu-v19.html) — but here we actually convert wmf/emf instead of just
// flagging them, since we have a real OS process (soffice) available server-side. ──
function runTextContent(inner) {
  const isSuper = /<w:vertAlign\s+w:val="superscript"/.test(inner);
  const isSub = /<w:vertAlign\s+w:val="subscript"/.test(inner);
  let out = '';
  const childRe = /<w:t[^>]*>([^<]*)<\/w:t>|<w:tab\s*\/?>|<w:br\s*\/?>/g;
  let cm;
  while ((cm = childRe.exec(inner)) !== null) {
    if (cm[1] !== undefined) out += cm[1];
    else if (cm[0].startsWith('<w:tab')) out += '\t';
    else if (cm[0].startsWith('<w:br')) out += '\n';
  }
  if (out && isSuper) out = `<sup>${out}</sup>`;
  else if (out && isSub) out = `<sub>${out}</sub>`;
  return out;
}

async function extractDocx(fileBuffer) {
  const zip = await JSZip.loadAsync(fileBuffer);
  const xmlFile = zip.file('word/document.xml');
  if (!xmlFile) throw new Error('Not a valid DOCX file');
  const xml = await xmlFile.async('string');

  const imgMap = {};      // rId -> base64 (already-renderable raster images)
  const wmfBytes = {};    // rId -> {buffer, ext} (needs soffice conversion)
  const relsFile = zip.file('word/_rels/document.xml.rels');
  if (relsFile) {
    const relsXml = await relsFile.async('string');
    const relRe = /<Relationship[^>]+Id="([^"]+)"[^>]+Target="([^"]+)"[^>]*>/g;
    let rm;
    while ((rm = relRe.exec(relsXml)) !== null) {
      const rId = rm[1], target = rm[2], ext = target.split('.').pop().toLowerCase();
      const imgPath = 'word/' + target.replace(/^\//, '');
      const f = zip.file(imgPath);
      if (!f) continue;
      if (/^(png|jpg|jpeg|gif|bmp)$/i.test(ext)) {
        const b64 = await f.async('base64');
        const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        imgMap[rId] = `data:${mime};base64,${b64}`;
      } else if (/^(wmf|emf)$/i.test(ext)) {
        wmfBytes[rId] = { buffer: await f.async('nodebuffer'), ext };
      }
    }
  }

  // Convert EVERY referenced wmf/emf up front, in one batched pass, BEFORE
  // touching any paragraph text. Doing this per-equation while parsing (388
  // separate soffice launches for a real full-length JEE paper) took several
  // minutes and would blow any HTTP timeout — batching cut a similarly-sized
  // real exam file down to well under a minute. See batchConvertWmf() for why
  // it's chunked rather than one giant batch.
  const wmfIds = Object.keys(wmfBytes);
  const convertedPng = wmfIds.length
    ? await batchConvertWmf(wmfIds.map((rId) => ({ rId, buffer: wmfBytes[rId].buffer, ext: wmfBytes[rId].ext })))
    : {};

  let text = '';
  const equations = [];   // {id, dataUrl}
  const images = [];      // {id, dataUrl}
  let eqCounter = 0, imgCounter = 0;
  let failedEquations = 0, failedImages = 0;

  const paraRe = /<w:p[ >]([\s\S]*?)<\/w:p>/g;
  let pm;
  while ((pm = paraRe.exec(xml)) !== null) {
    let para = pm[1];
    let paraText = '';

    // Legacy OLE equations/diagrams: <w:object> is nested INSIDE <w:r>, so we must
    // replace it with a <w:t>placeholder</w:t> BEFORE the run tokenizer runs, or
    // the enclosing <w:r> swallows it as unparsed content (see extractDocxText in
    // examsetu-v19.html for the full explanation of why this ordering matters).
    const objMatches = [...para.matchAll(/<w:object\b[\s\S]*?<\/w:object>/g)];
    for (const objM of objMatches) {
      const objXml = objM[0];
      const rIdM = /r:id="([^"]+)"/i.exec(objXml) || /r:href="([^"]+)"/i.exec(objXml);
      const rId = rIdM ? rIdM[1] : null;
      const isEquation = /ProgID="Equation/i.test(objXml) || /ProgID="MathType/i.test(objXml);
      let token;
      if (rId && wmfBytes[rId]) {
        eqCounter++;
        const dataUrl = convertedPng[rId];
        if (dataUrl) equations.push({ id: eqCounter, dataUrl });
        else failedEquations++;
        token = `[[EQIMG:${eqCounter}]]`;
      } else if (rId && imgMap[rId]) {
        imgCounter++;
        images.push({ id: imgCounter, dataUrl: imgMap[rId] });
        token = `[[IMG:${imgCounter}]]`;
      } else {
        token = isEquation ? '[Equation]' : '[Diagram]';
      }
      para = para.replace(objXml, `<w:t xml:space="preserve">${token}</w:t>`);
    }

    const tokenRe = /<(w:r|w:drawing|m:oMath|m:oMathPara)(?=[\s\/>])[^>]*>([\s\S]*?)<\/\1>/g;
    let tm;
    while ((tm = tokenRe.exec(para)) !== null) {
      const tag = tm[1], inner = tm[2];
      if (tag === 'w:r') {
        paraText += runTextContent(inner);
      } else if (tag.includes('drawing')) {
        const rIdM = /r:embed="([^"]+)"/.exec(inner) || /r:id="([^"]+)"/.exec(inner);
        if (rIdM && imgMap[rIdM[1]]) {
          imgCounter++;
          images.push({ id: imgCounter, dataUrl: imgMap[rIdM[1]] });
          paraText += `[[IMG:${imgCounter}]]`;
        } else {
          paraText += '[Diagram]';
        }
      } else if (tag.startsWith('m:oMath')) {
        const eqText = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        paraText += eqText ? `$${eqText}$` : '[Equation]';
      }
    }
    text += (paraText.trim() ? paraText : '') + '\n';
  }

  return {
    text: text.trim(),
    equations,
    images,
    stats: {
      totalEquations: eqCounter, failedEquations,
      totalImages: imgCounter, failedImages,
    },
  };
}

app.post('/convert-equations', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected field name "file")' });
  const ext = (req.file.originalname.split('.').pop() || '').toLowerCase();
  if (ext !== 'docx') {
    // Legacy binary .doc isn't handled here (no XML to parse) — caller falls
    // back to its own binary parser for those.
    return res.status(415).json({ error: 'Only .docx is supported by this endpoint (not legacy binary .doc)' });
  }
  try {
    const result = await extractDocx(req.file.buffer);
    res.json(result);
  } catch (e) {
    console.error('convert-equations failed:', e);
    res.status(500).json({ error: e.message || 'Conversion failed' });
  }
});

app.listen(PORT, () => console.log(`examsetu-doc-convert listening on port ${PORT}`));
