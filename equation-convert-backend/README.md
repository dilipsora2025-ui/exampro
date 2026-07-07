# ExamSetu — DOCX equation/diagram conversion backend

This is the missing piece that `examsetu-v19.html` was already trying to call
(`DOC_CONVERT_BACKEND_URL + '/convert-equations'`) but that never actually
existed as working code. It converts legacy Word "Equation Editor 3.0" /
MathType equations — embedded as OLE objects with WMF/EMF vector previews —
into real, tightly-cropped PNG images, using a real LibreOffice process
(browsers cannot decode WMF/EMF directly, no matter what MIME type you give
them — this is why equations were showing "[Equation — could not be
converted]").

**Tested against two real files, not synthetic samples:**
- A 7-equation exam docx: 7/7 converted, ~6-7 seconds.
- A full 90-question JEE mock test (AITS-2122-FT-III-JEEM) with **388**
  embedded equations: **388/388 converted, 0 failures, ~53 seconds.**

## Why batching matters (read this if you change CHUNK_SIZE)

Converting one equation at a time (spawn `soffice`, wait, repeat) pays
LibreOffice's ~1s startup cost per equation — for a 388-equation paper that's
several minutes, which will blow past any reasonable HTTP timeout. Passing
many files to a single `soffice --convert-to` invocation is dramatically
faster per file, BUT testing against the real 388-equation file showed
conversion silently plateaus at exactly ~248 output files no matter how long
the timeout is — reproduced twice, with different file sets, same exact
count, so it's an internal LibreOffice limit, not a timeout artifact. The
fix here is chunking into batches of 50 (`CHUNK_SIZE` in server.js) — safely
under that ceiling, while still getting nearly all of the batching speedup.
If you increase `CHUNK_SIZE`, re-test against a large real file before
trusting it — this ceiling was not documented anywhere, only found by testing.

## What it does

`POST /convert-equations` — send a `.docx` as multipart form field `file`.
Returns:
```json
{
  "text": "...paragraph text with [[EQIMG:1]] / [[IMG:1]] placeholders...",
  "equations": [{ "id": 1, "dataUrl": "data:image/png;base64,..." }],
  "images":    [{ "id": 1, "dataUrl": "data:image/png;base64,..." }],
  "stats": { "totalEquations": 388, "failedEquations": 0, "totalImages": 0, "failedImages": 0 }
}
```
This matches exactly what `examsetu-v19.html`'s `importFile()` already expects
— no frontend changes needed, just deploy this and point `DOC_CONVERT_BACKEND_URL`
at it. The frontend already shows a "Converting equations & images..." status
message during the wait, so a ~1-minute wait on a huge paper reads as
progress, not a frozen page.

## Deploy on Render

1. Push this folder to a GitHub repo (or a new folder in your existing one).
2. Render dashboard → **New +** → **Web Service** → connect the repo.
3. Render will auto-detect the `Dockerfile` — **make sure the Environment is
   set to "Docker"**, not "Node". This is important: the plain Node buildpack
   does not include LibreOffice, and the equation conversion will fail with
   "soffice: command not found" if you accidentally deploy without Docker.
4. **Set an environment variable** `ANTHROPIC_API_KEY` = your actual Anthropic
   API key (Render → your service → Environment tab). Without this, the new
   `/api/claude-proxy` route (used by PDF import's AI parser) will return a
   clear 500 error instead of silently failing — but PDF import needs a real
   key to work at all.
5. First request after idle (free tier spins down after ~15 min) will be slow
   (cold start + LibreOffice startup, 20-30s on top of normal conversion time)
   — this is normal on Render's free tier, not a bug.
6. **If you hit a proxy/gateway timeout on very large papers** (reports on
   Render's community forum mention request timeouts as low as 15-30s in some
   configurations): consider a paid instance, or reduce `CHUNK_SIZE` isn't the
   fix here — the total wall-clock time is what matters, so if timeouts are a
   problem, the real fix is making the endpoint return immediately with a job
   ID and polling for completion instead of blocking the whole request. Not
   implemented here since it adds real complexity — flag it if you hit this.
7. Copy the deployed URL (e.g. `https://your-service.onrender.com`) into
   `examsetu-v19.html`'s `DOC_CONVERT_BACKEND_URL` constant.

## Why there's a Claude proxy route in an equation-conversion backend

`/api/claude-proxy` doesn't belong here conceptually (it's for PDF import's AI
question-parser, not equation conversion) — it was added here purely because
this is the one backend URL the frontend already has wired up
(`DOC_CONVERT_BACKEND_URL`). The frontend was previously calling
`https://api.anthropic.com/v1/messages` directly from the browser with no API
key — this can never work (Anthropic requires an `x-api-key` header, and
doesn't allow direct browser/CORS calls anyway), and both failure modes show
up identically as a generic "Failed to fetch" with no further detail. This
route forwards the request server-side instead, with the real key kept out of
the browser entirely.

## Local testing

```bash
npm install
node server.js
curl -X POST -F "file=@/path/to/some.docx" http://localhost:4000/convert-equations
```

## Notes / limitations

- Only `.docx` is supported (legacy binary `.doc` has no XML to parse — the
  frontend already falls back to its own binary parser for those).
- Equations are rasterized as PNG, not converted to LaTeX — this is a
  pragmatic tradeoff: reconstructing correct LaTeX from an arbitrary WMF/EMF
  vector image is unreliable; a faithful rendered image is more trustworthy
  for an exam-question bank than a possibly-wrong LaTeX reconstruction.
- Regular embedded photos (`.png`/`.jpg`/`.gif`/`.bmp`) are passed through
  as-is (no conversion needed, they're already browser-renderable).
- Very large papers (300+ equations) take under a minute but not instant —
  see the timeout note above if this becomes a real problem for you.
