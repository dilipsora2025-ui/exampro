const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const JSZip = require('jszip');

function runCmd(cmd, args, cwd, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 300)}`));
    });
    const t = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    proc.on('close', () => clearTimeout(t));
  });
}

const CHUNK_SIZE = 50; // empirically: single soffice batch >~325 WMFs silently stalls; 50/chunk is safe & fast

/**
 * Converts MANY WMF/EMF files to trimmed PNGs in one pass, using LibreOffice's
 * native multi-file batch conversion (`soffice --convert-to png a.wmf b.wmf c.wmf ...`)
 * instead of spawning a separate process per file. A single soffice process startup
 * costs ~2-5s; for a paper with 300+ embedded equations, one-at-a-time conversion
 * takes several MINUTES. Batching brings the same workload down to ~20-30 seconds.
 *
 * Files are split into chunks of CHUNK_SIZE because empirically a single soffice
 * batch invocation with 300+ files silently stops partway through (observed: stalls
 * after ~325 of 361 files with no error) — likely an internal LO queue/memory limit.
 * Each chunk gets its own LibreOffice user-profile dir so chunks never collide.
 */
async function batchConvertWmfToPng(wmfPaths, workDir) {
  if (!wmfPaths.length) return new Map();

  const pngDir = path.join(workDir, 'wmf-png-batch');
  await fs.mkdir(pngDir, { recursive: true });

  const chunks = [];
  for (let i = 0; i < wmfPaths.length; i += CHUNK_SIZE) {
    chunks.push(wmfPaths.slice(i, i + CHUNK_SIZE));
  }

  for (let i = 0; i < chunks.length; i++) {
    const profileDir = path.join(workDir, `lo-batch-profile-${i}`);
    await fs.mkdir(profileDir, { recursive: true });
    await runCmd('soffice', [
      '--headless', '--norestore',
      `-env:UserInstallation=file://${profileDir}`,
      '--convert-to', 'png',
      '--outdir', pngDir,
      ...chunks[i]
    ], workDir, 90_000);
  }

  // Map original wmf path -> raw (untrimmed) png path
  const result = new Map();
  for (const wmfPath of wmfPaths) {
    const base = path.basename(wmfPath, path.extname(wmfPath));
    const pngPath = path.join(pngDir, base + '.png');
    if (fsSync.existsSync(pngPath)) {
      result.set(wmfPath, pngPath);
    }
    // If missing, that single conversion failed within its chunk — caller treats
    // it as `failed: true` rather than throwing, so one bad equation never sinks
    // the rest of the import.
  }
  return result;
}

/**
 * Trims a single rasterized PNG (removes the large surrounding whitespace
 * LibreOffice adds, keeps a small clean border).
 */
async function trimPng(rawPngPath, outPath) {
  await runCmd('convert', [
    rawPngPath, '-trim', '+repage',
    '-bordercolor', 'white', '-border', '4',
    outPath
  ], path.dirname(outPath), 15_000);
  return fsSync.existsSync(outPath) ? outPath : rawPngPath;
}

async function fileToDataUrl(filePath, mime = 'image/png') {
  const buf = await fs.readFile(filePath);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * Reads raw run-level text content from inside a <w:r>...</w:r> body,
 * correctly handling MULTIPLE <w:t> elements in one run (split by <w:tab/>
 * or formatting changes) — this was the #1 cause of silently dropped text
 * in the previous (frontend-only) extractor.
 */
function runTextContent(inner) {
  let out = '';
  const childRe = /<w:t[^>]*>([^<]*)<\/w:t>|<w:tab\s*\/?>|<w:br\s*\/?>/g;
  let cm;
  while ((cm = childRe.exec(inner)) !== null) {
    if (cm[1] !== undefined) out += cm[1];
    else if (cm[0].startsWith('<w:tab')) out += '\t';
    else if (cm[0].startsWith('<w:br')) out += '\n';
  }
  return out;
}

/**
 * Main entry point. Walks word/document.xml paragraph by paragraph, and for
 * EVERY element type that can appear inside a run — plain text, OLE-embedded
 * equation objects (<w:object>...<v:imagedata r:id="...">), inline drawings
 * (<w:drawing>...<a:blip r:embed="...">), and native OMML math (<m:oMath>) —
 * emits either text or an inline placeholder token, NEVER silently drops it.
 *
 * Placeholder tokens:
 *   [[EQIMG:n]]  — a converted equation image (was WMF/OLE, now PNG)
 *   [[IMG:n]]    — a converted diagram/figure image
 * These tokens stay inline in the returned text so the existing frontend
 * parser (parseQuestionsFromText) can match them to the right question by
 * position, exactly like real text.
 */
async function extractAndConvertEquations(docxPath, workDir) {
  const buf = await fs.readFile(docxPath);
  const zip = await JSZip.loadAsync(buf);

  const documentXmlFile = zip.file('word/document.xml');
  if (!documentXmlFile) throw new Error('Not a valid DOCX (missing word/document.xml)');
  const xml = await documentXmlFile.async('string');

  const relsFile = zip.file('word/_rels/document.xml.rels');
  const relsXml = relsFile ? await relsFile.async('string') : '';
  const relMap = {}; // rId -> media/imageN.ext
  const relRe = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g;
  let rm;
  while ((rm = relRe.exec(relsXml)) !== null) {
    relMap[rm[1]] = rm[2];
  }

  const mediaDir = path.join(workDir, 'extracted-media');
  await fs.mkdir(mediaDir, { recursive: true });

  // ── PASS 1: walk the document, build text + placeholder tokens, and record
  // (without converting yet) which media file each equation/image placeholder needs. ──
  const equationRefs = []; // {id, relTarget}
  const imageRefs = [];    // {id, relTarget}
  let eqCounter = 0;
  let imgCounter = 0;
  let text = '';

  const paraRe = /<w:p[ >]([\s\S]*?)<\/w:p>/g;
  let pm;
  while ((pm = paraRe.exec(xml)) !== null) {
    const para = pm[1];
    let paraText = '';

    // (?=[\s\/>]) boundary lookahead is REQUIRED — without it "w:r" also matches
    // "w:rPr"/"w:rFonts" run-PROPERTY tags via the \1 backreference, corrupting output.
    // NOTE: <w:object> (legacy equation) and <w:drawing> (image) live INSIDE a <w:r> run,
    // not as siblings of it — e.g. <w:r><w:rPr>...</w:rPr><w:object>...</w:object></w:r>.
    // A top-level scan for these as 4 separate alternatives only ever matches "w:r"
    // (greedy, non-overlapping) and silently swallows the nested object/drawing as
    // unparsed text. Each w:r body must be inspected for an embedded object/drawing
    // BEFORE falling back to plain text extraction.
    const tokenRe = /<(w:r|m:oMath|m:oMathPara)(?=[\s\/>])[^>]*>([\s\S]*?)<\/\1>/g;
    let tm;
    while ((tm = tokenRe.exec(para)) !== null) {
      const tag = tm[1], inner = tm[2];

      if (tag === 'w:r') {
        const objMatch = /<w:object[^>]*>([\s\S]*?)<\/w:object>/.exec(inner);
        const drawMatch = /<w:drawing[^>]*>([\s\S]*?)<\/w:drawing>/.exec(inner);

        if (objMatch) {
          const idMatch = /<v:imagedata[^>]*r:id="([^"]+)"/.exec(objMatch[1]);
          eqCounter++;
          paraText += `[[EQIMG:${eqCounter}]]`;
          equationRefs.push({ id: eqCounter, relTarget: (idMatch && relMap[idMatch[1]]) || null });
          paraText += runTextContent(inner.replace(objMatch[0], ''));
        } else if (drawMatch) {
          const blipMatch = /<a:blip[^>]*r:embed="([^"]+)"/.exec(drawMatch[1]);
          imgCounter++;
          paraText += `[[IMG:${imgCounter}]]`;
          imageRefs.push({ id: imgCounter, relTarget: (blipMatch && relMap[blipMatch[1]]) || null });
          paraText += runTextContent(inner.replace(drawMatch[0], ''));
        } else {
          paraText += runTextContent(inner);
        }
      } else if (tag === 'm:oMath' || tag === 'm:oMathPara') {
        // Native OMML math (modern Word equations) — already text-extractable,
        // wrap in $...$ so the frontend's KaTeX-ish renderer can pick it up directly.
        const eqText = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        paraText += eqText ? `$${eqText}$` : '';
      }
    }

    text += (paraText.trim() ? paraText : '') + '\n';
  }

  // ── PASS 2: extract every referenced media file to disk once, then batch-convert
  // all the WMF/EMF ones together (the slow part) instead of one process per file. ──
  const allRefs = [...equationRefs, ...imageRefs].filter(r => r.relTarget);
  const uniqueTargets = [...new Set(allRefs.map(r => r.relTarget))];

  const extractedPath = new Map(); // relTarget -> local file path (original format)
  for (const relTarget of uniqueTargets) {
    const mediaPath = 'word/' + relTarget.replace(/^\.?\/?/, '');
    const mediaFile = zip.file(mediaPath);
    if (!mediaFile) continue;
    const localPath = path.join(mediaDir, path.basename(mediaPath));
    await fs.writeFile(localPath, await mediaFile.async('nodebuffer'));
    extractedPath.set(relTarget, localPath);
  }

  const wmfTargets = uniqueTargets.filter(t => {
    const p = extractedPath.get(t);
    return p && /\.(wmf|emf)$/i.test(p);
  });
  const wmfPaths = wmfTargets.map(t => extractedPath.get(t));
  const wmfToRawPng = await batchConvertWmfToPng(wmfPaths, workDir); // wmfPath -> rawPngPath

  // Trim each converted PNG (fast, can stay sequential — ImageMagick trim is <100ms/file)
  const wmfToFinalDataUrl = new Map();
  for (const [target, rawPng] of [...wmfTargets.map(t => [t, wmfToRawPng.get(extractedPath.get(t))])]) {
    if (!rawPng) continue;
    const trimmedPath = rawPng.replace(/\.png$/, '-trimmed.png');
    const finalPath = await trimPng(rawPng, trimmedPath);
    wmfToFinalDataUrl.set(target, await fileToDataUrl(finalPath));
  }

  // Already-web-friendly formats (png/jpg/gif) — no conversion needed, just encode
  const directDataUrl = new Map();
  for (const target of uniqueTargets) {
    if (wmfToFinalDataUrl.has(target)) continue;
    const localPath = extractedPath.get(target);
    if (!localPath) continue;
    const ext = path.extname(localPath).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif'].includes(ext)) {
      const mime = ext === '.jpg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
      directDataUrl.set(target, await fileToDataUrl(localPath, mime));
    }
  }

  // ── PASS 3: map results back onto the original equation/image reference lists ──
  const equations = equationRefs.map(r => {
    const dataUrl = (r.relTarget && (wmfToFinalDataUrl.get(r.relTarget) || directDataUrl.get(r.relTarget))) || null;
    return { id: r.id, dataUrl, failed: !dataUrl };
  });
  const images = imageRefs.map(r => {
    const dataUrl = (r.relTarget && (wmfToFinalDataUrl.get(r.relTarget) || directDataUrl.get(r.relTarget))) || null;
    return { id: r.id, dataUrl, failed: !dataUrl };
  });

  return {
    text: text.trim(),
    equations,
    images,
    stats: {
      totalEquations: equations.length,
      failedEquations: equations.filter(e => e.failed).length,
      totalImages: images.length,
      failedImages: images.filter(i => i.failed).length,
    }
  };
}

module.exports = { extractAndConvertEquations };
