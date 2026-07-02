// ExamSetu shared backend
// - Admin/teacher app (examsetu-v19.html) publishes tests here.
// - Student app reads published tests from here, submits answers, gets scored.
//
// Storage: SQLite file at ./data/examsetu.db
// NOTE (Render free tier): this file lives on the instance's local disk. It survives
// restarts/idle spin-downs, but is WIPED on every new deploy. Good enough for a free
// MVP/demo; for real production use, attach a Render persistent disk (paid) or move
// to a hosted DB (Postgres/Supabase/etc).

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { JsonStore } = require('./store');

const PORT = process.env.PORT || 3000;
// CHANGE THIS in Render's Environment Variables tab — anyone with this key can manage
// students and publish tests. The admin app must send it back as `x-admin-key`.
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-this-admin-key';
// Used to sign student login tokens. Render: set a long random value in env vars.
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-jwt-secret';

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Single JSON file acting as the whole "database". Structure:
// { students: {id: {...}}, tests: {id: {...}}, questions: {id: {...}}, submissions: {id: {...}} }
const store = new JsonStore(path.join(dataDir, 'examsetu.json'), {
  students: {}, tests: {}, questions: {}, submissions: {},
});
const db = store.data;

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' })); // generous limit — questions can carry base64 images

function gid(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ── Admin auth middleware — simple shared-secret key, sent by the admin app ──
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Invalid or missing admin key' });
  next();
}

// ── Student auth middleware — JWT issued at login ──
function requireStudent(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.student = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

app.get('/', (req, res) => res.json({ ok: true, service: 'examsetu-backend' }));
app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// ════════════════════ ADMIN: student account management ════════════════════

app.post('/api/admin/students', requireAdmin, (req, res) => {
  const { username, password, name, class: cls } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const exists = Object.values(db.students).find(s => s.username === username);
  if (exists) return res.status(409).json({ error: 'Username already exists' });
  const id = gid('S');
  const hash = bcrypt.hashSync(password, 10);
  db.students[id] = { id, username, password_hash: hash, name: name || '', class: cls || '', created_at: Date.now() };
  store.commit();
  res.json({ id, username, name: name || '', class: cls || '' });
});

app.get('/api/admin/students', requireAdmin, (req, res) => {
  const rows = Object.values(db.students)
    .map(s => ({ id: s.id, username: s.username, name: s.name, class: s.class, created_at: s.created_at }))
    .sort((a, b) => b.created_at - a.created_at);
  res.json(rows);
});

app.delete('/api/admin/students/:id', requireAdmin, (req, res) => {
  delete db.students[req.params.id];
  store.commit();
  res.json({ ok: true });
});

app.put('/api/admin/students/:id/password', requireAdmin, (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'password required' });
  const s = db.students[req.params.id];
  if (!s) return res.status(404).json({ error: 'Student not found' });
  s.password_hash = bcrypt.hashSync(password, 10);
  store.commit();
  res.json({ ok: true });
});

// ════════════════════ ADMIN: publish a test (called automatically by the "Publish" button) ════════════════════
// Body: { test: {id,title,board,dur,mks,sections,qids,secMap,status}, questions: [questionObj,...] }
app.post('/api/admin/publish', requireAdmin, (req, res) => {
  const { test, questions } = req.body || {};
  if (!test || !test.id) return res.status(400).json({ error: 'test object with id required' });

  db.tests[test.id] = {
    id: test.id,
    title: test.title || 'Untitled Test',
    board: test.board || '',
    dur: test.dur || 180,
    mks: test.mks || 0,
    sections: test.sections || [],
    qids: test.qids || [],
    secMap: test.secMap || {},
    status: 'published',
    published_at: Date.now(),
  };

  (questions || []).forEach(q => { db.questions[q.id] = { ...q, test_id: test.id }; });
  store.commit();

  res.json({ ok: true, testId: test.id, questionCount: (questions || []).length });
});

app.post('/api/admin/tests/:id/unpublish', requireAdmin, (req, res) => {
  const t = db.tests[req.params.id];
  if (t) { t.status = 'draft'; store.commit(); }
  res.json({ ok: true });
});

app.get('/api/admin/tests', requireAdmin, (req, res) => {
  const rows = Object.values(db.tests)
    .map(t => ({ id: t.id, title: t.title, status: t.status, published_at: t.published_at }))
    .sort((a, b) => b.published_at - a.published_at);
  res.json(rows);
});

// ════════════════════ STUDENT: auth ════════════════════

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const row = Object.values(db.students).find(s => s.username === username);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = jwt.sign({ id: row.id, username: row.username, name: row.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, student: { id: row.id, username: row.username, name: row.name, class: row.class } });
});

app.get('/api/student/me', requireStudent, (req, res) => {
  res.json(req.student);
});

// ════════════════════ STUDENT: tests ════════════════════

function stripAnswers(q) {
  // Never send correct answers / solutions / internal fields to the student before they submit.
  const { correct, solution, test_id, ...safe } = q;
  if (safe.opts && safe.opts.subQs) {
    safe.opts = { ...safe.opts, subQs: safe.opts.subQs.map(sq => { const { correct: c, sol, ...s } = sq; return s; }) };
  }
  return safe;
}

app.get('/api/student/tests', requireStudent, (req, res) => {
  const tests = Object.values(db.tests).filter(t => t.status === 'published')
    .sort((a, b) => b.published_at - a.published_at);
  const submitted = new Set(
    Object.values(db.submissions).filter(s => s.student_id === req.student.id).map(s => s.test_id)
  );
  res.json(tests.map(t => ({
    id: t.id,
    title: t.title,
    board: t.board,
    dur: t.dur,
    mks: t.mks,
    sections: t.sections || [],
    publishedAt: t.published_at,
    attempted: submitted.has(t.id),
  })));
});

app.get('/api/student/tests/:id', requireStudent, (req, res) => {
  const t = db.tests[req.params.id];
  if (!t || t.status !== 'published') return res.status(404).json({ error: 'Test not found' });
  const qids = t.qids || [];
  const questions = qids.map(id => db.questions[id]).filter(Boolean).map(stripAnswers);
  res.json({
    id: t.id, title: t.title, board: t.board, dur: t.dur, mks: t.mks,
    sections: t.sections || [], secMap: t.secMap || {},
    questions,
  });
});

// Body: { answers: { [questionId]: answerValue } }
app.post('/api/student/tests/:id/submit', requireStudent, (req, res) => {
  const t = db.tests[req.params.id];
  if (!t || t.status !== 'published') return res.status(404).json({ error: 'Test not found' });
  const already = Object.values(db.submissions).find(s => s.student_id === req.student.id && s.test_id === t.id);
  if (already) return res.status(409).json({ error: 'Already submitted' });

  const { answers = {}, startedAt } = req.body || {};
  const qids = t.qids || [];

  let score = 0, maxScore = 0;
  const review = [];

  function scoreOne(id, q, given, marks, neg){
    let isCorrect = false;
    if (q.type === 'MMCQ') {
      const corrArr = Array.isArray(q.correct) ? [...q.correct].sort() : [];
      const givArr = Array.isArray(given) ? [...given].sort() : [];
      isCorrect = corrArr.length > 0 && JSON.stringify(corrArr) === JSON.stringify(givArr);
    } else if (q.type === 'INTEGER' || q.type === 'NUMERICAL') {
      isCorrect = given != null && given !== '' && String(given).trim() === String(q.correct).trim();
    } else if (q.type === 'MATRIX MATCH') {
      // All-or-nothing: every Column-A → Column-B mapping must match.
      const corr = q.correct || {};
      const giv = given || {};
      const keys = Object.keys(corr);
      isCorrect = keys.length > 0 && keys.every(k => String(giv[k] ?? '') === String(corr[k]));
    } else {
      // SMCQ, MATCH LIST — single-letter answer
      isCorrect = given != null && given !== '' && String(given) === String(q.correct);
    }
    let s = 0;
    if (given == null || given === '' || (typeof given === 'object' && given && Object.keys(given).length === 0)) {
      s = 0; // unattempted — no marks, no negative
    } else if (isCorrect) {
      s = marks || 0;
    } else {
      s = neg || 0;
    }
    score += s;
    maxScore += marks || 0;
    review.push({ id, correct: q.correct, given, isCorrect, solution: q.solution || '', marks, neg });
  }

  qids.forEach(id => {
    const q = db.questions[id];
    if (!q) return;
    if (q.type === 'PARAGRAPH') {
      // Each sub-question is independently scored, using the parent question's
      // marks/neg as the per-sub-question value (standard exam convention: every
      // sub-question in a paragraph set carries the section's standard marking).
      const subQs = (q.opts && q.opts.subQs) || [];
      subQs.forEach(sq => {
        const key = `${id}::${sq.n}`;
        const given = answers[key];
        scoreOne(key, { type: sq.type, correct: sq.correct, solution: sq.sol || '' }, given, q.marks, q.neg);
      });
    } else {
      scoreOne(id, q, answers[id], q.marks, q.neg);
    }
  });

  const subId = gid('SUB');
  db.submissions[subId] = {
    id: subId, student_id: req.student.id, test_id: t.id, answers,
    score, max_score: maxScore, started_at: startedAt || Date.now(), submitted_at: Date.now(),
  };
  store.commit();

  res.json({ score, maxScore, review });
});

app.get('/api/student/results', requireStudent, (req, res) => {
  const rows = Object.values(db.submissions)
    .filter(s => s.student_id === req.student.id)
    .map(s => ({
      id: s.id, test_id: s.test_id, score: s.score, max_score: s.max_score,
      submitted_at: s.submitted_at, title: (db.tests[s.test_id] || {}).title || '(deleted test)',
    }))
    .sort((a, b) => b.submitted_at - a.submitted_at);
  res.json(rows);
});

app.listen(PORT, () => console.log(`ExamSetu backend listening on port ${PORT}`));
