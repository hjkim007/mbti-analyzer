/**
 * Gemini REST 호출 공통 모듈 (서버 전용)
 * - 무료/유료 모델 분리 (환경변수)
 * - 일시 오류 재시도, 전체 마감 시각(deadline) 안에서만 시도
 * - 모델을 찾을 수 없을 때 대체 모델로 1회 재시도
 * - JSON 응답 파싱
 */

/** 예전부터 쓰던 모델 — 대체 모델 기본값 */
const LEGACY_DEFAULT_MODEL = "gemini-2.5-flash";

/** 유료 기본값: 빠른 추론형 상위 모델 (환경변수로 바꿀 수 있음) */
const DEFAULT_PREMIUM_MODEL = "gemini-4-argon";

export const MODEL_TIER = {
  FREE: "free",
  PREMIUM: "premium",
};

function envTrim(name) {
  const v = process.env[name];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * 티어별 모델.
 * - 무료: GEMINI_MODEL_FREE → (예전 변수) GEMINI_MODEL → gemini-2.5-flash
 * - 유료: GEMINI_MODEL_PREMIUM → gemini-4-argon
 * @param {"free"|"premium"} tier
 */
export function getModelForTier(tier) {
  if (tier === MODEL_TIER.PREMIUM) {
    return envTrim("GEMINI_MODEL_PREMIUM") || DEFAULT_PREMIUM_MODEL;
  }
  return (
    envTrim("GEMINI_MODEL_FREE") || envTrim("GEMINI_MODEL") || LEGACY_DEFAULT_MODEL
  );
}

/** 지정 모델을 쓸 수 없을 때 한 번 더 시도할 모델 */
export function getFallbackModel() {
  return (
    envTrim("GEMINI_MODEL_FALLBACK") || envTrim("GEMINI_MODEL") || LEGACY_DEFAULT_MODEL
  );
}

function getGenerateContentUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

/** 503·UNAVAILABLE 등 일시 오류 시 재시도 (환경변수로 조절, 기본 5회·최대 8회) */
function getGeminiMaxRetries() {
  const n = parseInt(process.env.GEMINI_MAX_RETRIES ?? "5", 10);
  if (!Number.isFinite(n)) return 5;
  return Math.min(8, Math.max(1, n));
}

function getGeminiRetryBaseMs() {
  const n = parseInt(process.env.GEMINI_RETRY_BASE_MS ?? "1200", 10);
  if (!Number.isFinite(n)) return 1200;
  return Math.min(8000, Math.max(400, n));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Google 측 일시 과부하·용량 — 잠시 후 재시도 가치 있음 */
function isTransientGeminiError(status, errText) {
  if (status === 503 || status === 502 || status === 504) return true;
  try {
    const j = JSON.parse(errText);
    const st = j?.error?.status;
    if (st === "UNAVAILABLE" || st === "DEADLINE_EXCEEDED") return true;
  } catch {
    /* 본문이 JSON이 아니면 status 코드만 사용 */
  }
  return false;
}

/** 모델 이름이 없거나 이 키로 쓸 수 없는 경우 */
function isModelUnavailableError(status, errText) {
  if (status !== 404 && status !== 400 && status !== 403) return false;
  const t = (errText || "").toLowerCase();
  return (
    (status === 404 && (t.includes("model") || t.includes("not_found"))) ||
    (t.includes("model") &&
      (t.includes("not found") ||
        t.includes("is not supported") ||
        t.includes("not available") ||
        t.includes("does not have access")))
  );
}

function throwGeminiHttpError(status, errText) {
  let parsed = null;
  try {
    parsed = JSON.parse(errText);
  } catch {
    /* 유지 */
  }
  const apiMsg = parsed?.error?.message;
  const unavailable =
    status === 503 ||
    parsed?.error?.status === "UNAVAILABLE" ||
    (typeof apiMsg === "string" && apiMsg.toLowerCase().includes("high demand"));
  const message = unavailable
    ? "AI 분석 서버가 잠시 과부하 상태예요. 1~2분 뒤 다시 시도해 주세요."
    : `Gemini API 오류 (${status}): ${errText.slice(0, 800)}`;
  const err = new Error(message);
  err.status = status;
  err.rawBody = errText;
  err.rawJson = parsed;
  throw err;
}

/** ```json ... ``` 등 마크다운 펜스 제거 */
function stripMarkdownJsonFence(s) {
  let t = s.trim();
  if (!t.startsWith("```")) return t;
  t = t.replace(/^```(?:json)?\s*/i, "");
  const last = t.lastIndexOf("```");
  if (last !== -1) t = t.slice(0, last);
  return t.trim();
}

/**
 * Gemini가 JSON 외 문자를 섞거나 잘랐을 때 파싱 시도
 * @param {string} raw
 */
export function parseGeminiJson(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;

  const candidates = [raw.trim(), stripMarkdownJsonFence(raw)];
  for (const chunk of candidates) {
    try {
      const v = JSON.parse(chunk);
      if (v && typeof v === "object") return v;
    } catch {
      /* 다음 시도 */
    }
  }

  const cleaned = stripMarkdownJsonFence(raw);
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      /* 복구 불가 */
    }
  }
  return null;
}

const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

/**
 * 한 모델로 요청 (일시 오류 재시도 포함)
 * @returns {Promise<Response>}
 */
async function requestWithRetries(model, body, { timeoutMs, deadline }) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Gemini API 키가 설정되지 않았습니다.");
  }

  const maxAttempts = getGeminiMaxRetries();
  const baseDelayMs = getGeminiRetryBaseMs();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const remaining = deadline ? deadline - Date.now() : Infinity;
    if (remaining < 4000) {
      throw new Error("ANALYSIS_TIMEOUT");
    }
    const attemptTimeout = Math.min(timeoutMs, remaining - 1000);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeout);
    let res;
    try {
      res = await fetch(`${getGenerateContentUrl(model)}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === "AbortError") throw new Error("ANALYSIS_TIMEOUT");
      throw err;
    }
    clearTimeout(timer);

    if (res.ok) return res;

    const errText = await res.text();

    if (res.status === 429 || errText.includes("RESOURCE_EXHAUSTED")) {
      const qe = new Error("QUOTA_EXCEEDED");
      qe.status = res.status;
      qe.rawBody = errText;
      try {
        qe.rawJson = JSON.parse(errText);
      } catch {
        qe.rawJson = null;
      }
      throw qe;
    }

    if (isModelUnavailableError(res.status, errText)) {
      const me = new Error("MODEL_UNAVAILABLE");
      me.status = res.status;
      me.rawBody = errText;
      throw me;
    }

    const canRetry = isTransientGeminiError(res.status, errText) && attempt < maxAttempts - 1;
    if (canRetry) {
      const wait = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 400);
      if (deadline && Date.now() + wait > deadline - 5000) {
        throwGeminiHttpError(res.status, errText);
      }
      console.warn(
        `[Gemini] ${model} 일시 오류 ${res.status}, ${attempt + 1}/${maxAttempts}회차 후 ${wait}ms 대기 후 재시도`,
      );
      await sleep(wait);
      continue;
    }

    throwGeminiHttpError(res.status, errText);
  }

  throw new Error("Gemini 요청이 반복 실패했습니다. 잠시 후 다시 시도해 주세요.");
}

/**
 * JSON 응답을 받는 Gemini 호출
 * @param {{
 *   tier: "free"|"premium",
 *   system: string,
 *   parts: Array<object>,
 *   temperature?: number,
 *   maxOutputTokens?: number,
 *   timeoutMs: number,
 *   deadline?: number,
 *   label?: string,
 * }} opts
 * @returns {Promise<{ json: any, model: string, ms: number }>}
 */
export async function generateJson({
  tier,
  system,
  parts,
  temperature = 0.3,
  maxOutputTokens = 8192,
  timeoutMs,
  deadline,
  label = "",
}) {
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature,
      maxOutputTokens,
      responseMimeType: "application/json",
      candidateCount: 1,
    },
    safetySettings: SAFETY_SETTINGS,
  };

  const started = Date.now();
  let model = getModelForTier(tier);
  let res;
  try {
    res = await requestWithRetries(model, body, { timeoutMs, deadline });
  } catch (err) {
    const fallback = getFallbackModel();
    if (err?.message === "MODEL_UNAVAILABLE" && fallback && fallback !== model) {
      console.warn(`[Gemini] ${label} 모델 ${model} 사용 불가 → ${fallback}로 재시도`);
      model = fallback;
      res = await requestWithRetries(model, body, { timeoutMs, deadline });
    } else if (err?.message === "MODEL_UNAVAILABLE") {
      throwGeminiHttpError(err.status || 404, err.rawBody || "model unavailable");
    } else {
      throw err;
    }
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  const finishReason = candidate?.finishReason;
  const text =
    candidate?.content?.parts
      ?.filter((p) => !p.thought)
      .map((p) => p.text)
      .filter(Boolean)
      .join("") ?? "";

  if (!text) {
    const block = data.promptFeedback?.blockReason;
    if (block) {
      const e = new Error(`Gemini 응답이 차단되었습니다: ${block}`);
      e.rawJson = data;
      throw e;
    }
    const e = new Error(
      finishReason === "MAX_TOKENS"
        ? "응답이 너무 길어 잘렸습니다. 이미지 수를 줄이거나 다시 시도해주세요."
        : "Gemini 응답이 비어있습니다.",
    );
    e.rawJson = data;
    e.stage = label;
    throw e;
  }

  const json = parseGeminiJson(text);
  if (!json) {
    console.error(`[Gemini] ${label} JSON 파싱 실패 (앞 600자):`, text.slice(0, 600));
    const pe = new Error(
      finishReason === "MAX_TOKENS"
        ? "응답이 잘려 JSON이 완성되지 않았습니다. 이미지를 줄이거나 다시 시도해주세요."
        : "AI 응답을 파싱할 수 없습니다. 다시 시도해주세요.",
    );
    pe.rawPreview = text.slice(0, 4000);
    pe.finishReason = finishReason;
    pe.stage = label;
    throw pe;
  }

  return { json, model, ms: Date.now() - started };
}

/** 이미지 배열 → Gemini inlineData parts */
export function imagesToParts(images) {
  return (images || []).map((img) => ({
    inlineData: {
      mimeType: img.mimeType || "image/jpeg",
      data: img.base64Data,
    },
  }));
}
