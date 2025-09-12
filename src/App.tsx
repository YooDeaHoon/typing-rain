import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Typing Rain – v15 FULL (Sheets + Multilingual + UX polish) + Mixed-mode spawn
 * 
 * Added features (per request):
 * - Auto focus input when Start pressed
 * - F2 global shortcut to Start (only when not running)
 * - Score frozen when lives == 0 (input still allowed; entities can still be cleared)
 * 
 * No truncation / full source. Fix1: avoid parameter destructuring in .filter to satisfy certain Babel parsers.
 */

// ============================
// Types
// ============================
type LangKey = "ko" | "en" | "vi" | "th";
type WordId = string;
type ToneMode = "strict" | "lenient"; // vi only

export type WordMap = Partial<Record<LangKey, string>>;

export interface Sentence {
  id: WordId;
  map: WordMap;
  weight?: number;
  active?: boolean;
}

interface FallingEntity {
  id: string;
  key: WordId;
  text: string;
  x: number;
  y: number;
  vy: number;
  bornAt: number;
  width: number;
}

// ============================
// Constants & defaults
// ============================
const GAME_HEIGHT = 420;
const FLOOR_OFFSET = 60;
const H_MARGIN = 12;
const PAD_X = 14;
const BORDER_W = 1;
const FONT_FAMILY =
  "Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
const FONT_SIZE_PX = 16;

export const WORDS_DEFAULT: Record<WordId, WordMap> = {
  apple: { ko: "사과", en: "apple", vi: "táo", th: "แอปเปิล" },
  car: { ko: "자동차", en: "car", vi: "ô tô", th: "รถยนต์" },
  person: { ko: "사람", en: "person", vi: "người", th: "คน" },
  motorcycle: { ko: "오토바이", en: "motorcycle", vi: "xe máy", th: "รถมอเตอร์ไซค์" },
};
const SAMPLE_DEFAULT: Sentence[] = Object.keys(WORDS_DEFAULT).map((id) => ({
  id,
  map: WORDS_DEFAULT[id],
  active: true,
  weight: 1,
}));

// ============================
// Normalization helpers
// ============================
function safeNormalize(
  s: string,
  form: "NFC" | "NFD" | "NFKC" | "NFKD" = "NFC"
) {
  try {
    return s.normalize(form);
  } catch {
    return s;
  }
}
function stripCombining(s: string) {
  try {
    return s.replace(/\p{M}+/gu, "");
  } catch {
    return s.replace(
      /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]+/g,
      ""
    );
  }
}
function stripViDiacritics(input: string) {
  const s = (input ?? "").replace(/đ/g, "d").replace(/Đ/g, "D");
  return stripCombining(safeNormalize(s, "NFD"));
}
function equalsVi(a: string, b: string, mode: ToneMode) {
  return mode === "lenient"
    ? stripViDiacritics(a).toLowerCase().trim() ===
        stripViDiacritics(b).toLowerCase().trim()
    : safeNormalize(a, "NFC").toLowerCase().trim() ===
        safeNormalize(b, "NFC").toLowerCase().trim();
}
function normCommon(s: unknown) {
  return safeNormalize(String(s ?? ""), "NFC").toLowerCase().trim();
}

// ============================
// Cross-language helpers
// ============================
function normForLang(text: string, lang: LangKey, toneMode: ToneMode): string {
  if (lang === "vi")
    return toneMode === "lenient"
      ? stripViDiacritics(text).toLowerCase().trim()
      : safeNormalize(text, "NFC").toLowerCase().trim();
  return safeNormalize(text, "NFC").toLowerCase().trim();
}
function startsWithForLang(
  hay: string,
  needle: string,
  lang: LangKey,
  toneMode: ToneMode
) {
  return normForLang(hay, lang, toneMode).startsWith(
    normForLang(needle, lang, toneMode)
  );
}
function fullEqualForLang(
  a: string,
  b: string,
  lang: LangKey,
  toneMode: ToneMode
) {
  return lang === "vi"
    ? equalsVi(a, b, toneMode)
    : normCommon(a) === normCommon(b);
}

type CrossPreview = {
  ok: boolean;
  isCross: boolean;
  inputLang: LangKey | null;
  variantText: string | null;
};
function findCrossPrefixMatch(
  wordId: WordId,
  input: string,
  displayLang: LangKey,
  toneMode: ToneMode,
  words: Record<WordId, WordMap>
): CrossPreview {
  const variants: WordMap = words[wordId] || {};
  if (
    variants[displayLang] &&
    startsWithForLang(variants[displayLang]!, input, displayLang, toneMode)
  ) {
    return {
      ok: true,
      isCross: false,
      inputLang: displayLang,
      variantText: variants[displayLang] || null,
    };
  }
  const langs: LangKey[] = ["ko", "en", "vi", "th"];
  for (const lg of langs) {
    if (lg === displayLang) continue;
    if (variants[lg] && startsWithForLang(variants[lg]!, input, lg, toneMode)) {
      return {
        ok: true,
        isCross: true,
        inputLang: lg,
        variantText: variants[lg] || null,
      };
    }
  }
  return { ok: false, isCross: false, inputLang: null, variantText: null };
}
function anyFullEqual(
  wordId: WordId,
  input: string,
  toneMode: ToneMode,
  words: Record<WordId, WordMap>
): boolean {
  const variants: WordMap = words[wordId] || {};
  const langs: LangKey[] = ["ko", "en", "vi", "th"];
  for (const lg of langs) {
    const v = variants[lg];
    if (v && fullEqualForLang(v, input, lg, toneMode)) return true;
  }
  return false;
}

// ============================
// RNG + weighted pick + measure
// ============================
function useRng(seedInit = Date.now()) {
  const seedRef = useRef(seedInit % 2147483647);
  return useMemo(
    () => () => {
      seedRef.current = (seedRef.current * 48271) % 2147483647;
      return (seedRef.current & 2147483647) / 2147483648;
    },
    []
  );
}
function pickWeighted(
  list: Sentence[],
  lang: LangKey,
  rnd: () => number
): Sentence | null {
  const pool = list.filter((s) => s.active !== false && !!s.map[lang]);
  if (pool.length === 0) return null;
  const total = pool.reduce((a, s) => a + (s.weight ?? 1), 0);
  let r = rnd() * total;
  for (const s of pool) {
    r -= s.weight ?? 1;
    if (r <= 0) return s;
  }
  return pool[pool.length - 1] ?? null;
}
function randInt(min: number, max: number, rnd: () => number) {
  return Math.floor(min + (max - min + 1) * rnd());
}
function makeTextMeasurer() {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const font = `${FONT_SIZE_PX}px ${FONT_FAMILY}`;
  return (text: string) => {
    if (!ctx) return text.length * FONT_SIZE_PX * 0.6;
    ctx.font = font;
    return ctx.measureText(text).width;
  };
}

// ============================
// CSV helpers (Sheets)
// ============================
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQ = true;
      } else if (ch === ",") {
        cur.push(field);
        field = "";
      } else if (ch === "\n") {
        cur.push(field);
        rows.push(cur);
        cur = [];
        field = "";
      } else if (ch === "\r") {
        // ignore
      } else {
        field += ch;
      }
    }
  }
  cur.push(field);
  rows.push(cur);
  return rows.filter(
    (r) => r.length > 1 || (r.length === 1 && r[0].trim() !== "")
  );
}
function buildRuntimeFromCsv(text: string): {
  words: Record<WordId, WordMap>;
  sample: Sentence[];
} | null {
  if (!text) return null;
  const table = parseCsv(text);
  if (table.length < 2) return null;
  const headers = table[0].map((h) => h.trim().toLowerCase());
  const idx = (name: string) => headers.indexOf(name);
  const idI = idx("id");
  if (idI < 0) return null;
  const langCols: { k: LangKey; i: number }[] = (["ko", "en", "vi", "th"] as LangKey[]).map(
    (k) => ({ k, i: idx(k) })
  );
  const weightI = idx("weight");
  const activeI = idx("active");

  const words: Record<WordId, WordMap> = {};
  const sample: Sentence[] = [];
  const seen = new Set<string>();

  for (let r = 1; r < table.length; r++) {
    const row = table[r];
    const id = (row[idI] || "").trim();
    if (!id || seen.has(id)) continue;
    const map: WordMap = {};
    let hasAny = false;
    for (const { k, i } of langCols) {
      if (i >= 0) {
        const v = (row[i] || "").trim();
        if (v) {
          map[k] = v;
          hasAny = true;
        }
      }
    }
    if (!hasAny) continue;
    const weight = weightI >= 0 ? Number((row[weightI] || "").trim()) : 1;
    const activeRaw =
      activeI >= 0
        ? String((row[activeI] || "").trim()).toLowerCase()
        : "true";
    const active =
      activeRaw === "" ? true : ["true", "1", "yes", "y"].includes(activeRaw);
    words[id] = map;
    sample.push({
      id,
      map,
      weight: isFinite(weight) && weight > 0 ? weight : 1,
      active,
    });
    seen.add(id);
  }
  if (sample.length === 0) return null;
  return { words, sample };
}

// ============================
// Engine hook
// ============================
function useTypingRainEngine() {
  const [lang, setLang] = useState<LangKey>("ko");
  const [toneMode, setToneMode] = useState<ToneMode>("strict");
  const [speed, setSpeed] = useState(35);
  const [spawnMs, setSpawnMs] = useState(1800);
  const [maxConcurrent, setMaxConcurrent] = useState(5);
  const [timeLimit, setTimeLimit] = useState(120);

  const [running, setRunning] = useState(false);
  const [entities, setEntities] = useState<FallingEntity[]>([]);
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [timeLeft, setTimeLeft] = useState(timeLimit);
  const [input, setInput] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [lastSolvedId, setLastSolvedId] = useState<WordId | null>(null);

  const [wordsRt, setWordsRt] = useState<Record<WordId, WordMap> | null>(null);
  const [sampleRt, setSampleRt] = useState<Sentence[] | null>(null);

  const [previewTargetId, setPreviewTargetId] = useState<string | null>(null);
  const [previewLen, setPreviewLen] = useState<number>(0);
  const [previewLabel, setPreviewLabel] = useState<string>("");
  const [previewIsCross, setPreviewIsCross] = useState<boolean>(false);
  const [previewCrossInfo, setPreviewCrossInfo] = useState<string>("");

  const [errorFx, setErrorFx] = useState(false);
  const [guideMsg, setGuideMsg] = useState<string>("");
  const lastErrorAtRef = useRef<number>(0);
  const ERROR_COOLDOWN_MS = 450;
  const GUIDE_DURATION_MS = 1000;

  const inputRef = useRef<HTMLInputElement | null>(null);

  const rng = useRng();
  const lastSpawnRef = useRef(0);
  const lastTsRef = useRef<number | null>(null);
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const entsRef = useRef<FallingEntity[]>([]);
  const measureRef = useRef<(t: string) => number>(() => 0);
  useEffect(() => {
    entsRef.current = entities;
  }, [entities]);
  useEffect(() => {
    measureRef.current = makeTextMeasurer();
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("tr_settings");
      if (raw) {
        const o = JSON.parse(raw);
        if (typeof o.spawnMs === "number")
          setSpawnMs(Math.max(300, Math.min(5000, o.spawnMs)));
        if (typeof o.speed === "number")
          setSpeed(Math.max(20, Math.min(300, o.speed)));
        if (typeof o.maxConcurrent === "number")
          setMaxConcurrent(Math.max(1, Math.min(9, o.maxConcurrent)));
      }
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(
        "tr_settings",
        JSON.stringify({ spawnMs, speed, maxConcurrent })
      );
    } catch {}
  }, [spawnMs, speed, maxConcurrent]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("tr_words_cache");
      if (raw) {
        const cache = JSON.parse(raw);
        if (typeof cache.text === "string") {
          const built = buildRuntimeFromCsv(cache.text);
          if (built) {
            setWordsRt(built.words);
            setSampleRt(built.sample);
          }
        }
      }
    } catch {}
  }, []);

  const getWords = () => wordsRt ?? WORDS_DEFAULT;
  const getSample = () => sampleRt ?? SAMPLE_DEFAULT;

  useEffect(() => {
    const onResize = () => {
      const fieldW = fieldRef.current?.clientWidth ?? 0;
      if (!fieldW) return;
      setEntities((prev) =>
        prev.map((e) => {
          const maxX = Math.max(H_MARGIN, fieldW - H_MARGIN - e.width);
          const clampedX = Math.max(H_MARGIN, Math.min(e.x, maxX));
          return { ...e, x: clampedX };
        })
      );
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const calcSpawnX = (
    fieldW: number,
    text: string
  ): { x: number; boxW: number } => {
    const textW = measureRef.current(text);
    const boxW = Math.ceil(textW + PAD_X * 2 + BORDER_W * 2);
    const maxX = Math.max(H_MARGIN, fieldW - H_MARGIN - boxW);
    const minX = H_MARGIN;
    const x = randInt(minX, maxX, rng);
    return { x, boxW };
  };

  const spawnOne = () => {
    const src = getSample();
    const s = pickWeighted(src, lang, rng);
    if (!s) {
      setBanner("No active words for selected language.");
      setRunning(false);
      return;
    }
    const raw = s.map[lang];
    const text = String(raw ?? "").trim();
    if (!text) {
      setBanner("Selected word has empty text.");
      setRunning(false);
      return;
    }
    const fieldW = fieldRef.current?.clientWidth ?? 600;
    const { x, boxW } = calcSpawnX(fieldW, text);
    const e: FallingEntity = {
      id: `${s.id}_${Date.now()}_${Math.floor(Math.random() * 9999)}`,
      key: s.id,
      text,
      x,
      y: -16,
      vy: speed,
      bornAt: performance.now(),
      width: boxW,
    };
    setEntities((prev) => [...prev, e]);
  };

  const reset = () => {
    setEntities([]);
    setScore(0);
    setLives(3);
    setTimeLeft(timeLimit);
    setInput("");
    setBanner(null);
    setLastSolvedId(null);
    setPreviewTargetId(null);
    setPreviewLen(0);
    setPreviewLabel("");
    setPreviewIsCross(false);
    setPreviewCrossInfo("");
    setErrorFx(false);
    setGuideMsg("");
    lastSpawnRef.current = 0;
    lastTsRef.current = null;
  };

  const start = () => {
    reset();
    setRunning(true);
    if (entsRef.current.length < maxConcurrent) spawnOne();
    setTimeout(() => inputRef.current?.focus(), 0);
  };
  const pause = () => setRunning(false);

  const playBeep = () => {
    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 220;
      g.gain.value = 0.001;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      const t = ctx.currentTime;
      g.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.stop(t + 0.2);
    } catch {}
  };

  const updatePreview = (v: string) => {
    if (!v) {
      setPreviewTargetId(null);
      setPreviewLen(0);
      setPreviewLabel("");
      setPreviewIsCross(false);
      setPreviewCrossInfo("");
      return;
    }
    const W = getWords();
    const cands = entsRef.current
      .map((e) => ({
        e,
        m: findCrossPrefixMatch(e.key, v, lang, toneMode, W),
      }))
      .filter((p) => p.m.ok);
    if (cands.length === 0) {
      setPreviewTargetId(null);
      setPreviewLen(0);
      setPreviewLabel("");
      setPreviewIsCross(false);
      setPreviewCrossInfo("");
      return;
    }
    const pick = cands.reduce((a, b) => (a.e.y > b.e.y ? a : b));
    const target = pick.e;
    const m = pick.m;
    setPreviewTargetId(target.id);
    setPreviewLen(v.length);
    setPreviewIsCross(!!m.isCross);
    if (m.isCross && m.inputLang) {
      setPreviewLabel(`Matching: "${target.text}"`);
      setPreviewCrossInfo(`(${lang} ← ${m.inputLang}: "${m.variantText}")`);
    } else {
      setPreviewLabel(`Matching: "${target.text}"`);
      setPreviewCrossInfo("");
    }
  };

  const confirmInput = () => {
    const v = input;
    if (!v) return;
    setEntities((prev) => {
      if (prev.length === 0) return prev;
      const W = getWords();
      const cands = prev
        .map((e) => ({
          e,
          m: findCrossPrefixMatch(e.key, v, lang, toneMode, W),
        }))
        .filter((p) => p.m.ok);
      if (cands.length === 0) {
        const now = performance.now();
        if (now - lastErrorAtRef.current >= ERROR_COOLDOWN_MS) {
          lastErrorAtRef.current = now;
          setErrorFx(true);
          setGuideMsg("⚠️ No matching word found");
          playBeep();
          setTimeout(() => setErrorFx(false), 320);
          setTimeout(() => setGuideMsg(""), GUIDE_DURATION_MS);
        }
        return prev;
      }
      const pick = cands.reduce((a, b) => (a.e.y > b.e.y ? a : b));
      const target = pick.e;
      const fullMatch = anyFullEqual(target.key, v, toneMode, W);
      if (fullMatch) {
        if (livesRef.current > 0) {
          const base = 100 + Math.max(0, target.text.length - 2) * 5;
          const fieldH = fieldRef.current?.clientHeight ?? GAME_HEIGHT;
          const hRatio = Math.max(0, 1 - target.y / Math.max(1, fieldH));
          const bonus = Math.round(50 * hRatio);
          setScore((s) => s + base + bonus);
        }
        setLastSolvedId(target.key);
        setInput("");
        setPreviewTargetId(null);
        setPreviewLen(0);
        setPreviewLabel("");
        setPreviewIsCross(false);
        setPreviewCrossInfo("");
        return prev.filter((e) => e.id !== target.id);
      }
      const now = performance.now();
      if (now - lastErrorAtRef.current >= ERROR_COOLDOWN_MS) {
        lastErrorAtRef.current = now;
        setErrorFx(true);
        setGuideMsg("⚠️ Input does not fully match the word");
        playBeep();
        setTimeout(() => setErrorFx(false), 320);
        setTimeout(() => setGuideMsg(""), GUIDE_DURATION_MS);
      }
      return prev;
    });
  };

  const timeLeftRef = useRef(timeLeft);
  useEffect(() => {
    timeLeftRef.current = timeLeft;
  }, [timeLeft]);
  const livesRef = useRef(lives);
  useEffect(() => {
    livesRef.current = lives;
  }, [lives]);

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    const tick = (ts: number) => {
      const fieldH = fieldRef.current?.clientHeight ?? GAME_HEIGHT;
      if (lastTsRef.current == null) lastTsRef.current = ts;
      const dt = Math.min(0.05, (ts - lastTsRef.current) / 1000);
      lastTsRef.current = ts;

      setEntities((prev) => {
        const moved = prev.map((e) => ({ ...e, y: e.y + e.vy * dt }));
        const survivors: FallingEntity[] = [];
        let miss = 0;
        const floorY = fieldH - FLOOR_OFFSET;
        for (const e of moved) {
          if (e.y >= floorY) miss++;
          else survivors.push(e);
        }
        if (miss > 0) setLives((L) => Math.max(0, L - miss));
        return survivors;
      });
      setTimeLeft((t) => Math.max(0, t - dt));

      if (
        timeLeftRef.current > 0 &&
        livesRef.current > 0 &&
        entsRef.current.length === 0
      ) {
        spawnOne();
        lastSpawnRef.current = 0;
      } else {
        lastSpawnRef.current += dt * 1000;
        if (lastSpawnRef.current >= spawnMs) {
          lastSpawnRef.current = 0;
          if (entsRef.current.length < maxConcurrent) spawnOne();
        }
      }

      if (timeLeftRef.current <= 0 || livesRef.current <= 0) {
        setRunning(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, spawnMs, maxConcurrent, speed, lang, toneMode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault();
        if (!running) start();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running]);

  const setRuntimeData = (
    words: Record<WordId, WordMap> | null,
    sample: Sentence[] | null
  ) => {
    // 1) Apply new dataset
    setWordsRt(words);
    setSampleRt(sample);

    // 2) Purge existing entities & reset preview/guide states
    setEntities([]);
    setPreviewTargetId(null);
    setPreviewLen(0);
    setPreviewLabel("");
    setPreviewIsCross(false);
    setPreviewCrossInfo("");
    setErrorFx(false);
    setGuideMsg("");

    // 3) Reset spawn timers for clean scheduling
    lastSpawnRef.current = 0;
    lastTsRef.current = null;

    // 4) If game is running and still valid, spawn one fresh entity on next tick
    if (running && timeLeftRef.current > 0 && livesRef.current > 0) {
      setTimeout(() => {
        if (entsRef.current.length === 0) {
          try { spawnOne(); } catch {}
        }
      }, 0);
    }
  };

  return {
    lang,
    setLang,
    toneMode,
    setToneMode,
    speed,
    setSpeed,
    spawnMs,
    setSpawnMs,
    maxConcurrent,
    setMaxConcurrent,
    timeLimit,
    setTimeLimit,
    running,
    start,
    pause,
    reset,
    entities,
    score,
    lives,
    timeLeft,
    input,
    onInput: (v: string) => {
      setInput(v);
      updatePreview(v);
    },
    confirmInput,
    banner,
    setBanner,
    fieldRef,
    inputRef,
    previewTargetId,
    previewLen,
    previewLabel,
    previewIsCross,
    previewCrossInfo,
    errorFx,
    guideMsg,
    lastSolvedId,
    wordsRt,
    sampleRt,
    setRuntimeData,
  } as const;
}

// ============================
// Component UI
// ============================
export default function TypingRainApp(): React.ReactElement {
  const E = useTypingRainEngine();

  const TESTS = [
    { name: "vi strict ≠", ok: equalsVi("người", "nguoi", "strict") === false },
    { name: "vi lenient =", ok: equalsVi("người", "nguoi", "lenient") === true },
    { name: "anyFullEqual ko apple", ok: anyFullEqual("apple", "사과", "strict", WORDS_DEFAULT) === true },
  ];
  const testsOK = TESTS.every((t) => t.ok);

  const [lifePopKey, setLifePopKey] = useState(0);
  const prevLivesRef = useRef(E.lives);
  useEffect(() => {
    if (E.lives < prevLivesRef.current) setLifePopKey(Date.now());
    prevLivesRef.current = E.lives;
  }, [E.lives]);

  const [showSettings, setShowSettings] = useState(false);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [showGuide, setShowGuide] = useState(false);

  const [sheetId, setSheetId] = useState<string>("");
  const [sheetTab, setSheetTab] = useState<string>("Sheet1");
  const [loadMsg, setLoadMsg] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("tr_settings_ui");
      if (raw) {
        const o = JSON.parse(raw);
        if (typeof o.offsetX === "number")
          setOffsetX(Math.max(-40, Math.min(40, o.offsetX)));
        if (typeof o.offsetY === "number")
          setOffsetY(Math.max(-40, Math.min(40, o.offsetY)));
        if (typeof o.showGuide === "boolean") setShowGuide(o.showGuide);
      }
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(
        "tr_settings_ui",
        JSON.stringify({ offsetX, offsetY, showGuide })
      );
    } catch {}
  }, [offsetX, offsetY, showGuide]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("tr_data_source");
      if (raw) {
        const o = JSON.parse(raw);
        if (o.sheetId) setSheetId(o.sheetId);
        if (o.sheetTab) setSheetTab(o.sheetTab);
      }
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(
        "tr_data_source",
        JSON.stringify({ sheetId, sheetTab })
      );
    } catch {}
  }, [sheetId, sheetTab]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("tr_words_cache");
      if (raw) {
        const cache = JSON.parse(raw);
        if (typeof cache.text === "string") {
          const built = buildRuntimeFromCsv(cache.text);
          if (built) {
            E.setRuntimeData(built.words, built.sample);
          }
        }
      }
    } catch {}
  }, []);

  const s = styles;
  const keyframes = `
  @keyframes tr-shake { 0%{transform:translateX(0)} 25%{transform:translateX(-4px)} 50%{transform:translateX(4px)} 75%{transform:translateX(-3px)} 100%{transform:translateX(0)} }
  @keyframes tr-pulse { 0%{box-shadow:0 0 0 0 rgba(16,185,129,0.6)} 70%{box-shadow:0 0 0 12px rgba(16,185,129,0)} 100%{box-shadow:0 0 0 0 rgba(16,185,129,0)} }
  @keyframes tr-pop { 0%{transform:scale(1.25); opacity:.6} 100%{transform:scale(1); opacity:1} }
  `;

  const currentWords = E.wordsRt ?? WORDS_DEFAULT;
  const lastSolved = E.lastSolvedId ? currentWords[E.lastSolvedId] : null;

  async function loadFromSheet() {
    if (!sheetId) {
      setLoadMsg("Enter a public Google Sheet ID.");
      return;
    }
    setLoading(true);
    setLoadMsg("Loading…");
    const isGid = /^\d+$/.test(sheetTab.trim());
    const param = isGid
      ? `gid=${encodeURIComponent(sheetTab.trim())}`
      : `sheet=${encodeURIComponent(sheetTab.trim() || "Sheet1")}`
    const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(
      sheetId
    )}/gviz/tq?tqx=out:csv&${param}`;
    try {
      const res = await fetch(url, { mode: "cors" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const built = buildRuntimeFromCsv(text);
      if (!built) {
        setLoadMsg("Invalid CSV or no valid rows. Falling back to local sample.");
        return;
      }
      E.setRuntimeData(built.words, built.sample);
      setLoadMsg(`Loaded ${built.sample.length} words from sheet.`);
      try {
        localStorage.setItem("tr_words_cache", JSON.stringify({ text }));
      } catch {}
    } catch (err: any) {
      console.warn("Sheet load error", err);
      setLoadMsg(
        "Load failed (check public access or Sheet ID/Tab). Using local sample."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={s.app}>
      <div style={s.container}>
        <header style={s.header}>
          <h1 style={s.h1}>Typing Rain</h1>
          <div style={s.stats}>
            <span>Score: {E.score}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span>Lives:</span>
              <span aria-label={`Lives: ${E.lives}`}>
                {Array.from({ length: E.lives }).map((_, i) => (
                  <span
                    key={`${i}-${i === E.lives - 1 ? lifePopKey : 0}`}
                    style={{
                      fontSize: 18,
                      lineHeight: "1",
                      marginRight: 2,
                      filter: "drop-shadow(0 1px 0 rgba(0,0,0,.25))",
                      animation:
                        i === E.lives - 1 && lifePopKey
                          ? "tr-pop 0.25s ease-out"
                          : undefined,
                      display: "inline-block",
                    }}
                  >
                    🐱
                  </span>
                ))}
              </span>
            </span>
            <span>Time: {Math.ceil(E.timeLeft)}s</span>
          </div>
        </header>

        {E.banner && <div style={s.banner}>{E.banner}</div>}

        <div style={s.controls}>
          {!E.running ? (
            <button style={s.btnPrimary} onClick={E.start}>
              Start (F2)
            </button>
          ) : (
            <button style={s.btn} onClick={E.pause}>
              Pause
            </button>
          )}
          <button style={s.btn} onClick={E.reset}>
            Reset
          </button>
            <button style={s.btn} onClick={() => setShowSettings(true)}>
            Settings
          </button>
          <label style={s.label}>
            Language
            <select
              value={E.lang}
              onChange={(e) => E.setLang(e.target.value as LangKey)}
              style={s.select}
            >
              <option value="ko">ko</option>
              <option value="vi">vi</option>
              <option value="en">en</option>
              <option value="th">th</option>
            </select>
          </label>
          {E.lang === "vi" && (
            <label style={s.label}>
              VI Tone
              <select
                value={E.toneMode}
                onChange={(e) => E.setToneMode(e.target.value as ToneMode)}
                style={s.select}
              >
                <option value="strict">Strict</option>
                <option value="lenient">Lenient</option>
              </select>
            </label>
          )}
          <div style={{ flexBasis: "100%", height: 0 }} />
          <div
            style={{
              marginTop: 6,
              fontSize: 12,
              opacity: 0.9,
              maxWidth: "100%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            <strong>Last solved:</strong>{" "}
            {lastSolved ? (
              <>
                ko: <span>"{lastSolved.ko ?? ""}"</span> · en:{" "}
                <span>"{lastSolved.en ?? ""}"</span> · vi:{" "}
                <span>"{lastSolved.vi ?? ""}"</span> · th:{" "}
                <span>"{lastSolved.th ?? ""}"</span>
              </>
            ) : (
              <span>None</span>
            )}
          </div>
        </div>

        <div ref={E.fieldRef} style={s.playfield}>
          <style>{`
            @keyframes tr-shake { 0%{transform:translateX(0)} 25%{transform:translateX(-4px)} 50%{transform:translateX(4px)} 75%{transform:translateX(-3px)} 100%{transform:translateX(0)} }
            @keyframes tr-pulse { 0%{box-shadow:0 0 0 0 rgba(16,185,129,0.6)} 70%{box-shadow:0 0 0 12px rgba(16,185,129,0)} 100%{box-shadow:0 0 0 0 rgba(16,185,129,0)} }
            @keyframes tr-pop { 0%{transform:scale(1.25); opacity:.6} 100%{transform:scale(1); opacity:1} }
          `}</style>
          <div style={s.floor} />
          {E.entities.map((e) => {
            const isTarget = e.id === E.previewTargetId;
            const text = e.text;
            const k = isTarget
              ? E.previewIsCross
                ? 0
                : Math.min(E.previewLen, text.length)
              : 0;
            const head = text.slice(0, k);
            const tail = text.slice(k);
            return (
              <div
                key={e.id}
                style={{
                  ...s.entity,
                  transform: `translate(${e.x}px, ${e.y}px)`,
                  width: e.width,
                  borderColor: isTarget ? "#10b981" : (s.entity as any).borderColor,
                  animation: isTarget ? "tr-pulse 0.9s ease-out infinite" : undefined,
                }}
              >
                {k > 0 ? (
                  <>
                    <span style={{ fontWeight: 800, textDecoration: "underline" }}>
                      {head}
                    </span>
                    <span>{tail}</span>
                  </>
                ) : (
                  text
                )}
              </div>
            );
          })}

          {showGuide && (
            <div
              style={{
                position: "absolute",
                left: 12 + offsetX,
                right: 12 - offsetX,
                bottom: 8 + offsetY,
                height: 46,
                border: "1px solid #10b981",
                borderRadius: 12,
                pointerEvents: "none",
              }}
            />
          )}

          <div style={{ ...s.inputDock }}>
            <input
              ref={E.inputRef}
              value={E.input}
              onChange={(ev) => E.onInput(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") {
                  ev.preventDefault();
                  E.confirmInput();
                }
              }}
              placeholder="Type then press Enter…"
              style={{
                ...s.inputField,
                transform: `translate(${offsetX}px, ${-offsetY}px)`,
                borderColor: E.errorFx ? "#ef4444" : (s.inputField as any).borderColor,
                animation: E.errorFx ? "tr-shake 0.2s" : undefined,
              }}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginTop: 6,
                fontSize: 12,
                opacity: 0.85,
              }}
            >
              <span>
                {/* preview label/cross info */}
                {E.previewLabel}{" "}
                {E.previewCrossInfo && (
                  <span style={{ color: "#60a5fa" }}> {E.previewCrossInfo}</span>
                )}
              </span>
              <span style={{ color: "#fca5a5" }}>{E.guideMsg}</span>
            </div>
          </div>
        </div>

        {showSettings && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.45)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 50,
            }}
          >
            <div
              style={{
                width: "min(880px, 94vw)",
                border: "1px solid #334155",
                background: "#0b1220",
                color: "#e5e7eb",
                borderRadius: 12,
                boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "12px 14px",
                  borderBottom: "1px solid #334155",
                }}
              >
                <strong>Settings</strong>
                <button style={s.btn} onClick={() => setShowSettings(false)}>
                  Close
                </button>
              </div>
              <div style={{ padding: 14, display: "grid", gap: 12 }}>
                <section>
                  <h3 style={{ fontSize: 14, opacity: 0.9, marginBottom: 6 }}>
                    Alignment · Input Offsets
                  </h3>
                  <div style={{ display: "grid", gap: 8 }}>
                    <label
                      style={{
                        display: "grid",
                        gridTemplateColumns: "120px 1fr 80px",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span>offsetX (px)</span>
                      <input
                        type="range"
                        min={-40}
                        max={40}
                        value={offsetX}
                        onChange={(e) => setOffsetX(parseInt(e.target.value))}
                      />
                      <input
                        type="number"
                        value={offsetX}
                        onChange={(e) =>
                          setOffsetX(
                            Math.max(-40, Math.min(40, parseInt(e.target.value || "0")))
                          )
                        }
                        style={s.input}
                      />
                    </label>
                    <label
                      style={{
                        display: "grid",
                        gridTemplateColumns: "120px 1fr 80px",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span>offsetY (px)</span>
                      <input
                        type="range"
                        min={-40}
                        max={40}
                        value={offsetY}
                        onChange={(e) => setOffsetY(parseInt(e.target.value))}
                      />
                      <input
                        type="number"
                        value={offsetY}
                        onChange={(e) =>
                          setOffsetY(
                            Math.max(-40, Math.min(40, parseInt(e.target.value || "0")))
                          )
                        }
                        style={s.input}
                      />
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={showGuide}
                        onChange={(e) => setShowGuide(e.target.checked)}
                      />
                      <span>Show guide line (thin lime)</span>
                    </label>
                  </div>
                </section>

                <section>
                  <h3 style={{ fontSize: 14, opacity: 0.9, margin: "8px 0 6px" }}>
                    Gameplay · Spawning
                  </h3>
                  <div style={{ display: "grid", gap: 8 }}>
                    <label
                      style={{
                        display: "grid",
                        gridTemplateColumns: "160px 1fr 100px",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span>Spawn (ms)</span>
                      <input
                        type="range"
                        min={300}
                        max={5000}
                        step={100}
                        value={E.spawnMs}
                        onChange={(e) =>
                          E.setSpawnMs(
                            Math.max(
                              300, Math.min(5000, parseInt(e.target.value || "1800") || 1800)
                            )
                          )
                        }
                      />
                      <input
                        type="number"
                        value={E.spawnMs}
                        onChange={(e) =>
                          E.setSpawnMs(
                            Math.max(
                              300, Math.min(5000, parseInt(e.target.value || "1800") || 1800)
                            )
                          )
                        }
                        style={s.input}
                      />
                    </label>
                    <label
                      style={{
                        display: "grid",
                        gridTemplateColumns: "160px 1fr 100px",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span>Speed (px/s)</span>
                      <input
                        type="range"
                        min={20}
                        max={300}
                        step={5}
                        value={E.speed}
                        onChange={(e) =>
                          E.setSpeed(
                            Math.max(20, Math.min(300, parseInt(e.target.value || "35") || 35))
                          )
                        }
                      />
                      <input
                        type="number"
                        value={E.speed}
                        onChange={(e) =>
                          E.setSpeed(
                            Math.max(20, Math.min(300, parseInt(e.target.value || "35") || 35))
                          )
                        }
                        style={s.input}
                      />
                    </label>
                    <label
                      style={{
                        display: "grid",
                        gridTemplateColumns: "160px 1fr 100px",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span>Max Concurrent</span>
                      <input
                        type="range"
                        min={1}
                        max={9}
                        step={1}
                        value={E.maxConcurrent}
                        onChange={(e) =>
                          E.setMaxConcurrent(
                            Math.max(1, Math.min(9, parseInt(e.target.value || "5") || 5))
                          )
                        }
                      />
                      <input
                        type="number"
                        value={E.maxConcurrent}
                        onChange={(e) =>
                          E.setMaxConcurrent(
                            Math.max(1, Math.min(9, parseInt(e.target.value || "5") || 5))
                          )
                        }
                        style={s.input}
                      />
                    </label>
                  </div>
                </section>

                <section>
                  <h3 style={{ fontSize: 14, opacity: 0.9, margin: "8px 0 6px" }}>
                    Data Source · Google Sheets
                  </h3>
                  <div style={{ display: "grid", gap: 8 }}>
                    <label
                      style={{
                        display: "grid",
                        gridTemplateColumns: "160px 1fr",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span>Sheet ID</span>
                      <input
                        value={sheetId}
                        onChange={(e) => setSheetId(e.target.value)}
                        placeholder="1ZendTj5iE5v..."
                        style={{ ...s.input, width: "100%" }}
                      />
                    </label>
                    <label
                      style={{
                        display: "grid",
                        gridTemplateColumns: "160px 1fr",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span>Tab (name or gid)</span>
                      <input
                        value={sheetTab}
                        onChange={(e) => setSheetTab(e.target.value)}
                        placeholder="Sheet1 or 0"
                        style={{ ...s.input, width: "100%" }}
                      />
                    </label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        style={s.btnPrimary}
                        onClick={loadFromSheet}
                        disabled={loading}
                      >
                        {loading ? "Loading…" : "Load / Refresh"}
                      </button>
                      <span
                        style={{ fontSize: 12, opacity: 0.9, alignSelf: "center" }}
                      >
                        {loadMsg}
                      </span>
                    </div>
                  </div>
                </section>

                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button
                    style={s.btn}
                    onClick={() => {
                      setOffsetX(0);
                      setOffsetY(0);
                    }}
                  >
                    Reset to Default
                  </button>
                  <button style={s.btnPrimary} onClick={() => setShowSettings(false)}>
                    OK
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: "pointer" }}>
            Self-tests ({testsOK ? "OK" : "FAIL"})
          </summary>
          <ul style={{ fontSize: 12, opacity: 0.9, marginTop: 6 }}>
            {TESTS.map((t) => (
              <li
                key={t.name}
                style={{ color: t.ok ? "#a7f3d0" : "#fecaca" }}
              >
                {t.name}: {t.ok ? "pass" : "fail"}
              </li>
            ))}
          </ul>
        </details>

        <footer style={s.footer}>
          Sheets · Multilingual · VI tone · No-clipping spawns · Enter-confirm ·
          Preview highlight · Error beep · Mixed-mode spawn · F2 start · Auto focus · Score freeze on 0 life
        </footer>
      </div>
    </div>
  );
}

// ============================
// Styles (inline)
// ============================
const styles: Record<string, React.CSSProperties> = {
  app: {
    minHeight: "100vh",
    background: "#0f172a",
    color: "#e5e7eb",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE_PX,
  },
  container: { width: "min(980px, 94vw)", padding: 16 },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 },
  h1: { fontSize: 18, fontWeight: 800, letterSpacing: 0.2 },
  stats: { display: "flex", gap: 12, fontSize: 12, opacity: 0.9 },
  banner: {
    marginTop: 10,
    padding: 10,
    borderRadius: 10,
    border: "1px solid #f59e0b80",
    background: "#78350f66",
    color: "#fde68a",
  },
  controls: {
    marginTop: 10,
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    alignItems: "center",
    fontSize: 12,
  },
  btnPrimary: {
    padding: "8px 12px",
    borderRadius: 10,
    border: "1px solid #10b981",
    background: "#059669",
    color: "white",
    cursor: "pointer",
  },
  btn: {
    padding: "8px 12px",
    borderRadius: 10,
    border: "1px solid #64748b",
    background: "#1f2937",
    color: "white",
    cursor: "pointer",
  },
  label: { display: "flex", alignItems: "center", gap: 6 },
  select: {
    background: "#111827",
    color: "white",
    border: "1px solid #374151",
    borderRadius: 8,
    padding: "6px 8px",
  },
  input: {
    background: "#111827",
    color: "white",
    border: "1px solid #374151",
    borderRadius: 8,
    padding: "6px 8px",
    width: 140,
  },
  playfield: {
    position: "relative",
    marginTop: 12,
    height: GAME_HEIGHT,
    borderRadius: 14,
    border: "1px solid #334155",
    background: "#0b1220",
    overflow: "hidden",
  },
  floor: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: FLOOR_OFFSET,
    height: 2,
    background: "#334155",
  },
  entity: {
    position: "absolute",
    top: 0,
    left: 0,
    padding: `${PAD_X}px 14px`,
    borderRadius: 12,
    border: `${BORDER_W}px solid #475569`,
    background: "#1e293b",
    boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
    whiteSpace: "nowrap",
  },
  inputDock: { position: "absolute", left: 12, right: 12, bottom: 8 },
  inputField: {
    width: "100%",
    padding: "12px 14px",
    borderRadius: 12,
    border: "1px solid #475569",
    background: "#111827",
    color: "white",
    outline: "none",
  },
  footer: { marginTop: 12, fontSize: 12, opacity: 0.7 },
};
