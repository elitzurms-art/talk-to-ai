/* מכשיר קשר חכם — אפליקציית דפדפן לדבר עם AI בעברית.
   זיהוי דיבור והקראה: מובנים בדפדפן (חינם). מוח: Gemini. */

"use strict";

const MODEL = "gemini-2.5-flash";
const SYSTEM_PROMPT =
  "אתה עוזר קולי חכם בעברית בתוך מכשיר קשר. ענה תמיד קצר, טבעי ובעברית בלבד. " +
  "בלי רשימות ארוכות, בלי מרקדאון, בלי אימוג'ים. " +
  "פורמט התשובה שלך חייב להיות בדיוק כך: קודם התשובה בעברית, אחר כך הסימן ||| , " +
  "ואז אותה תשובה בדיוק בתעתיק פונטי באותיות לטיניות (כדי שמנוע הקראה אנגלי יוכל להגות אותה נכון). " +
  "התעתיק צריך לשקף את ההגייה העברית כולל תנועות. " +
  "דוגמה: שלום, איך אפשר לעזור?|||shalom, eikh efshar laazor? " +
  "אל תוסיף שום דבר אחרי התעתיק.";

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// --- אלמנטים ---
const el = (id) => document.getElementById(id);
const setupScreen = el("setup");
const appScreen = el("app");
const unsupportedScreen = el("unsupported");
const keyInput = el("keyInput");
const conversation = el("conversation");
const statusEl = el("status");
const talkBtn = el("talkBtn");
const textInput = el("textInput");
const sendBtn = el("sendBtn");

let apiKey = localStorage.getItem("gemini_key") || "";
let history = [];        // [{role:'user'|'model', parts:[{text}]}]
let listening = false;
let recognition = null;
let busy = false;        // מונע עיבוד כפול של אותה הודעה
let handsFree = false;   // מצב שיחה רציף (מקשיב אוטומטית)
let speaking = false;    // ה-AI מקריא כרגע

// ---------- אתחול ----------
function init() {
  if (!SR) { show(unsupportedScreen); return; }
  if (!apiKey) { show(setupScreen); keyInput.focus(); return; }
  show(appScreen);
  // טעינת קולות ההקראה (לפעמים נטענים מאוחר)
  if (window.speechSynthesis) speechSynthesis.getVoices();
}

function show(screen) {
  [setupScreen, appScreen, unsupportedScreen].forEach((s) => s.classList.add("hidden"));
  screen.classList.remove("hidden");
}

// ---------- שמירת מפתח ----------
el("saveKey").addEventListener("click", saveKey);
keyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveKey(); });
function saveKey() {
  const v = keyInput.value.trim();
  if (!v) { keyInput.focus(); return; }
  apiKey = v;
  localStorage.setItem("gemini_key", v);
  unlockAudio();
  show(appScreen);
}

// ---------- הגדרות ----------
el("settingsBtn").addEventListener("click", () => {
  if (confirm("לאפס את מפתח ה-Gemini ולהזין מחדש?")) {
    localStorage.removeItem("gemini_key");
    apiKey = "";
    history = [];
    conversation.innerHTML = "";
    keyInput.value = "";
    show(setupScreen);
  }
});

// ---------- קלט טקסט ----------
sendBtn.addEventListener("click", sendText);
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing && !e.repeat) {
    e.preventDefault();
    sendText();
  }
});
function sendText() {
  unlockAudio();
  const t = textInput.value.trim();
  if (!t) return;
  textInput.value = "";
  handleUser(t);
}

// ---------- כפתור מיקרופון = הפעלה/כיבוי מצב שיחה רציף ----------
talkBtn.addEventListener("click", () => {
  unlockAudio();
  if (handsFree) {
    handsFree = false;
    stopRecognition();
    talkBtn.classList.remove("listening", "active");
    setStatus("מצב שיחה כבוי. לחץ על המיקרופון כדי לדבר רצוף");
  } else {
    handsFree = true;
    talkBtn.classList.add("active");
    setStatus("מקשיב... דבר");
    startRecognition();
  }
});

function startRecognition() {
  if (busy || speaking || !handsFree) return;
  if (recognition) { try { recognition.abort(); } catch (e) {} }
  recognition = new SR();
  recognition.lang = "he-IL";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    listening = true;
    talkBtn.classList.add("listening");
    setStatus("מקשיב... דבר");
  };
  recognition.onresult = (e) => {
    const text = e.results[0][0].transcript.trim();
    if (text) handleUser(text);
  };
  recognition.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      handsFree = false;
      talkBtn.classList.remove("active");
      setStatus("צריך לאשר גישה למיקרופון");
    }
    // no-speech / aborted — onend יחזיר להקשבה אוטומטית
  };
  recognition.onend = () => {
    listening = false;
    talkBtn.classList.remove("listening");
    // מצב רציף: אם לא מדברים ולא מעבדים — חוזרים להקשיב
    if (handsFree && !speaking && !busy) {
      setTimeout(() => {
        if (handsFree && !speaking && !busy) startRecognition();
      }, 300);
    }
  };
  try { recognition.start(); } catch (e) {}
}

function stopRecognition() {
  if (recognition) { try { recognition.abort(); } catch (e) {} }
  listening = false;
  talkBtn.classList.remove("listening");
}

function resumeListening() {
  if (handsFree && !busy && !speaking) startRecognition();
}

// ---------- זרימת שיחה ----------
async function handleUser(text) {
  if (busy) return;          // כבר מעבדים הודעה — מתעלמים מטריגר כפול
  busy = true;
  if (recognition) { try { recognition.abort(); } catch (e) {} }
  addBubble(text, "user");
  setStatus("חושב...");
  talkBtn.classList.add("thinking");
  sendBtn.disabled = true;
  let toSpeak = null;
  try {
    const reply = await askGemini(text);
    // מפצלים: מימין ל-||| התעתיק להקראה, משמאלו העברית לתצוגה.
    const idx = reply.indexOf("|||");
    const display = idx >= 0 ? reply.slice(0, idx).trim() : reply;
    toSpeak = idx >= 0 ? reply.slice(idx + 3).trim() : reply;
    addBubble(display, "ai");
    setStatus(handsFree ? "מקשיב..." : "כתוב הודעה או לחץ על המיקרופון");
  } catch (err) {
    const m = (err && err.message) ? err.message : String(err);
    const friendly = /RATE_LIMIT|quota|rate|429/i.test(m)
      ? "רגע, יותר מדי בקשות כרגע. נסה שוב בעוד כחצי דקה 🙏"
      : "שגיאה: " + m;
    addBubble(friendly, "ai");
    setStatus("אירעה שגיאה");
  } finally {
    talkBtn.classList.remove("thinking");
    sendBtn.disabled = false;
    busy = false;
  }
  // קודם הקראה, ובסיומה חוזרים להקשיב (במצב רציף)
  if (toSpeak) speak(toSpeak, resumeListening);
  else resumeListening();
}

async function askGemini(userText) {
  history.push({ role: "user", parts: [{ text: userText }] });
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    MODEL + ":generateContent?key=" + encodeURIComponent(apiKey);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: history,
      // מכבים "חשיבה" כדי שהמודל לא יפלוט הנמקות באנגלית לתוך התשובה.
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    history.pop();
    if (res.status === 429) throw new Error("RATE_LIMIT");
    throw new Error((data.error && data.error.message) || ("HTTP " + res.status));
  }
  const cand = data.candidates && data.candidates[0];
  const parts = cand && cand.content && cand.content.parts;
  // מסננים חלקי "מחשבה" (thought) ולוקחים רק את טקסט התשובה.
  const text = parts
    ? parts.filter((p) => !p.thought).map((p) => p.text || "").join("").trim()
    : "";
  history.push({ role: "model", parts: [{ text }] });
  return text || "(לא התקבלה תשובה)";
}

// ---------- הקראה ----------
// מנוע ראשי: Google Translate TTS (עברית אמיתית, ללא תלות במערכת, ללא מפתח).
// נפילה אחורה: מנוע ההקראה של הדפדפן.
const ttsAudio = new Audio();
let audioUnlocked = false;

// "פותח" את האודיו במחווה הראשונה של המשתמש (דרישת דפדפן להשמעה אוטומטית).
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    ttsAudio.src = makeSilentWav();
    const p = ttsAudio.play();
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* מתעלמים */ }
}

function makeSilentWav() {
  const sr = 8000, n = 400; // ~0.05 שניות שקט
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const s = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  s(0, "RIFF"); v.setUint32(4, 36 + n, true); s(8, "WAVE");
  s(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr, true);
  v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  s(36, "data"); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

function stopSpeaking() {
  try { ttsAudio.pause(); } catch (e) {}
  if (window.speechSynthesis) speechSynthesis.cancel();
}

function chunkText(text, max) {
  // Google TTS מוגבל באורך — מפצלים למקטעים לפי גבולות מילים.
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const chunks = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max) {
      if (cur) chunks.push(cur.trim());
      cur = w;
    } else {
      cur += " " + w;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length ? chunks : [text];
}

function speak(text, onDone) {
  const done = () => { speaking = false; if (onDone) onDone(); };
  if (!text || !window.speechSynthesis) { done(); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  // קול אנגלי הוגה היטב את התעתיק הלטיני — וכך זה נשמע עברית.
  const voices = speechSynthesis.getVoices();
  const en = voices.find((v) => v.lang && /^en/i.test(v.lang));
  if (en) { u.voice = en; u.lang = en.lang; }
  u.rate = 0.95;
  speaking = true;
  u.onend = done;
  u.onerror = done;
  speechSynthesis.speak(u);
}

function speakBrowser(text) {
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "he-IL";
  const voices = speechSynthesis.getVoices();
  const he = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("he"));
  if (he) u.voice = he;
  speechSynthesis.speak(u);
}

// ---------- עזרי תצוגה ----------
function addBubble(text, who) {
  const div = document.createElement("div");
  div.className = "bubble " + who;
  div.textContent = text;
  conversation.appendChild(div);
  conversation.scrollTop = conversation.scrollHeight;
}
function setStatus(t) { statusEl.textContent = t; }

// ---------- Service Worker (להתקנה כאפליקציה) ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

init();
