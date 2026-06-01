/* מכשיר קשר חכם — אפליקציית דפדפן לדבר עם AI בעברית.
   זיהוי דיבור והקראה: מובנים בדפדפן (חינם). מוח: Gemini. */

"use strict";

const MODEL = "gemini-2.5-flash";
const SYSTEM_PROMPT =
  "אתה עוזר קולי חכם בעברית בתוך מכשיר קשר. " +
  "המשתמש מדבר אליך ושומע אותך בקול, אז ענה בעברית, בקצרה ובטבעיות — כמו בשיחה. " +
  "הימנע מרשימות ארוכות, סימני מרקדאון או אימוג'ים, כי הכל מוקרא בקול. " +
  "אם משהו לא ברור, בקש מהמשתמש לחזור.";

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

// ---------- כפתור דיבור ----------
talkBtn.addEventListener("click", () => {
  unlockAudio();
  if (listening) stopListening();
  else startListening();
});

function startListening() {
  recognition = new SR();
  recognition.lang = "he-IL";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    listening = true;
    talkBtn.classList.add("listening");
    setStatus("מקשיב... דבר עכשיו");
    stopSpeaking();
  };
  recognition.onresult = (e) => {
    const text = e.results[0][0].transcript.trim();
    if (text) handleUser(text);
  };
  recognition.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      setStatus("צריך לאשר גישה למיקרופון");
    } else if (e.error === "no-speech") {
      setStatus("לא שמעתי כלום, נסה שוב");
    } else {
      setStatus("שגיאת זיהוי: " + e.error);
    }
  };
  recognition.onend = () => {
    listening = false;
    talkBtn.classList.remove("listening");
  };
  recognition.start();
}

function stopListening() {
  if (recognition) recognition.stop();
}

// ---------- זרימת שיחה ----------
async function handleUser(text) {
  if (busy) return;          // כבר מעבדים הודעה — מתעלמים מטריגר כפול
  busy = true;
  addBubble(text, "user");
  setStatus("חושב...");
  talkBtn.classList.add("thinking");
  sendBtn.disabled = true;
  try {
    const reply = await askGemini(text);
    addBubble(reply, "ai");
    speak(reply);
    setStatus("כתוב הודעה או לחץ על המיקרופון");
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    addBubble("שגיאה: " + msg, "ai");
    setStatus("אירעה שגיאה");
  } finally {
    talkBtn.classList.remove("thinking");
    sendBtn.disabled = false;
    busy = false;
  }
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
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    history.pop();
    throw new Error((data.error && data.error.message) || ("HTTP " + res.status));
  }
  const cand = data.candidates && data.candidates[0];
  const parts = cand && cand.content && cand.content.parts;
  const text = parts ? parts.map((p) => p.text || "").join("").trim() : "";
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

function speak(text) {
  if (!text) return;
  stopSpeaking();
  const chunks = chunkText(text, 180);
  let i = 0;
  let fellBack = false;

  const fallback = () => {
    if (fellBack) return;
    fellBack = true;
    speakBrowser(text);
  };

  const playNext = () => {
    if (i >= chunks.length) return;
    ttsAudio.src =
      "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=iw&q=" +
      encodeURIComponent(chunks[i]);
    ttsAudio.onended = () => { i++; playNext(); };
    ttsAudio.onerror = () => { if (i === 0) fallback(); };
    const p = ttsAudio.play();
    if (p && p.catch) p.catch(() => { if (i === 0) fallback(); });
  };

  playNext();
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
