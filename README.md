# ExamSetu DOC-Convert Backend

Ye chhota backend ExamSetu ke liye sirf **ek kaam** karta hai: purane `.doc`/`.docx`
papers mein jo equations **images ki tarah** (legacy MS Equation Editor 3.0 / WMF format)
embedded hote hain, unhe browser-readable **PNG images** mein convert karta hai, taaki
import ke time equations aur diagrams blank na rahein.

## Yeh kyun zaroori hai (background)

Bahut saare purane (2015-2020 ke aas-paas bane) JEE/NEET test papers mein equations
Word ke andar **MS Equation Editor 3.0** se bani hoti hain. Word inhe save karte time
**WMF image** ke roop mein store karta hai — text ke roop mein nahi. Browsers WMF format
ko render nahi kar sakte, aur isliye sirf frontend JavaScript se inhe parse karna possible
nahi hai. Sirf ek tool reliably WMF ko convert kar sakta hai: **LibreOffice** — jo sirf
server pe chalta hai, browser ke andar nahi.

Isliye yeh ek chhota standalone backend hai jo sirf is ek conversion-kaam ke liye hai.
Baaki sab ExamSetu app (questions, tests, dashboards, etc.) waisa hi single-file
client-side HTML hai jaisa pehle tha — koi database ya account system backend mein nahi hai.

## Kya karta hai

```
POST /convert-equations
  Body: multipart/form-data, field "file" = .doc ya .docx

  Response: {
    "text": "...extracted text with [[EQIMG:1]] / [[IMG:1]] inline placeholder tokens...",
    "equations": [{ "id": 1, "dataUrl": "data:image/png;base64,..." }, ...],
    "images":    [{ "id": 1, "dataUrl": "data:image/png;base64,..." }, ...],
    "stats": { "totalEquations": 388, "failedEquations": 0, "totalImages": 8, "failedImages": 0 }
  }
```

ExamSetu ka frontend (`examsetu-vXX.html`) is response ko leke `[[EQIMG:n]]`/`[[IMG:n]]`
tokens ko actual `<img>` tags se replace kar deta hai (function: `stitchImagesIntoQuestions`),
phir wahi existing `parseQuestionsFromText` parser chalata hai jo pehle se kaam kar raha tha.

## Local testing

```bash
npm install
node src/server.js
# Server: http://localhost:8787

curl -X POST http://localhost:8787/convert-equations \
  -F "file=@/path/to/your-paper.doc" \
  -o result.json
```

## Free deployment (recommended: Render.com)

Render.com ka free tier Docker images directly support karta hai, isliye yeh sabse
aasaan hai (no separate "install LibreOffice" step needed — Dockerfile handles it):

1. Is `examsetu-backend` folder ko ek naye GitHub repo mein push karo
2. [render.com](https://render.com) pe jao → **New → Web Service** → apna repo connect karo
3. Render apne aap `Dockerfile` detect kar lega — "Docker" environment select karo
4. Free instance type choose karo, **Create Web Service** click karo
5. Build hone mein 5-10 minute lagega (LibreOffice install hota hai), uske baad URL milega
   jaisे: `https://examsetu-convert.onrender.com`

   ⚠️ Free tier note: agar 15 min tak koi request na aaye to service "sleep" ho jaati hai,
   agli request pe ~30-50 second cold-start lagta hai. Production/paid use ke liye paid
   tier ($7/month se) consider karna — woh hamesha "warm" rehta hai.

### Alternative: Railway.app
Similar process — Dockerfile auto-detect ho jaata hai, free tier $5/month credit deta hai.

## ExamSetu HTML ko connect karna

`examsetu-vXX.html` file kholo, search karo:

```javascript
const DOC_CONVERT_BACKEND_URL = '';
```

Apna deployed URL daal do:

```javascript
const DOC_CONVERT_BACKEND_URL = 'https://examsetu-convert.onrender.com';
```

Bas itna hi — ab jab bhi koi `.doc`/`.docx` upload hoga, ExamSetu automatically backend
ko call karega. Agar backend down ho ya URL khali ho, app automatically purane client-side
parser pe fallback ho jaata hai (equations text placeholder ki tarah dikhenge aur question
"Needs Review" flag ho jaayega — app crash nahi hoga).

## Security notes (production ke liye zaroori)

- `src/server.js` mein `cors()` abhi sab origins allow karta hai. Production mein isse
  apne ExamSetu domain tak restrict karo:
  ```javascript
  app.use(cors({ origin: 'https://your-examsetu-domain.com' }));
  ```
- File size limit already 30MB set hai (`multer` limits) — zyada bada nahi hone dena
- Har request apna temp folder use karta hai aur khatam hote hi delete ho jaata hai —
  koi uploaded file server pe permanently store nahi hoti

## Performance

- Ek typical 90-question JEE paper (300-400 embedded equations) ko convert karne mein
  ~45-60 seconds lagte hain (LibreOffice batch conversion, 50 files per batch — isliye
  itna fast hai; ek-ek equation alag se convert karne mein 5-10x zyada time lagta)
- Concurrent requests handle ho sakti hain (har request apna isolated LibreOffice profile
  use karta hai), lekin free-tier servers pe CPU limited hota hai — heavy concurrent
  load ke liye paid tier better rahega
