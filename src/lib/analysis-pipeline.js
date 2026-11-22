/**
 * 단계별 분석 파이프라인 (서버 전용)
 *
 * 유료(premium): ① 단서 추출(이미지) → ② 판단(텍스트) → ③ 작성(텍스트)
 * 무료(free):    ① 단서 추출(이미지) → ②+③ 판단·작성 한 번에
 *
 * 각 단계의 지침은 docs/mbti_skills_v2.md 의 섹션에서 가져온다(analysis-guide.js).
 * 최종 결과는 기존 결과 화면이 쓰는 JSON 스키마(free/premium)를 그대로 따른다.
 */

import { ANALYSIS_MODE } from "./analysis-tier";
import { getRelationshipLabel } from "@/constants/mbti-data";
import { getGuide } from "./analysis-guide";
import { generateJson, imagesToParts, MODEL_TIER } from "./gemini-client";

/** 단계별 1회 요청 상한(ms) — 실제로는 전체 마감 시각(deadline) 안에서 잘림 */
const STAGE_TIMEOUT = {
  free: { extract: 60000, write: 60000 },
  premium: { extract: 110000, judge: 80000, write: 110000 },
};

/** 전체 파이프라인 예산(ms). route.js maxDuration 보다 조금 짧게. */
const TOTAL_BUDGET = {
  free: 110000,
  premium: 285000,
};

/** 무료 결과 1순위 confidence 상한 */
const FREE_MAX_CONFIDENCE = 72;

const AXES = ["EI", "SN", "TF", "JP"];
const AXIS_LETTERS = { EI: ["E", "I"], SN: ["S", "N"], TF: ["T", "F"], JP: ["J", "P"] };
const TYPE_RE = /^[EI][SN][TF][JP]$/;

// ─────────────────────────────────────────────
// 출력 스키마 (단계별)
// ─────────────────────────────────────────────

const EXTRACT_SCHEMA = `{
  "targetIdentified": true,
  "targetIdentifyNote": "대상 말풍선을 어떻게 구분했는지 1문장",
  "context": {
    "type": "친밀|업무|가족|단톡방|혼합|알수없음",
    "topics": ["약속 잡기", "위로" 등 장면 주제],
    "note": "맥락 판단 근거 1문장"
  },
  "targetMessages": [{ "id": "t1", "image": 1, "text": "보이는 그대로", "time": "오후 3:12 또는 null" }],
  "otherMessages": [{ "id": "o1", "image": 1, "text": "보이는 그대로" }],
  "baseline": {
    "target": { "length": "짧게 여러 개|한 번에 길게|섞임", "laugh": "많음|보통|적음|없음", "cry": "…", "tilde": "…", "emoticon": "…", "period": "…", "speech": "반말|존댓말|섞임", "initiates": "자주|가끔|거의 안 함|알수없음" },
    "other": { 같은 키 }
  },
  "signals": [{
    "id": "s1", "axis": "EI|SN|TF|JP", "direction": "E|I|S|N|T|F|J|P",
    "strength": "강|중|약", "messageIds": ["t3"], "quote": "짧은 인용",
    "observation": "무엇을 봤는지 1문장", "confound": "다른 해석 가능성 1문장 또는 null"
  }],
  "profileMood": "프로필 분위기 1문장 또는 null",
  "dataQuality": { "targetMessageCount": 0, "sceneCount": 0, "level": "충분|보통|부족", "needMore": "1문장 또는 null" }
}`;

const JUDGE_SCHEMA = `{
  "axes": {
    "EI": { "result": "E|I", "strength": "강함|보통|약함|판단 보류", "confidence": 0, "forSignals": ["s1", "행동문항: 단톡방 참여도"], "againstSignals": ["s4"], "reasoning": "2~3문장" },
    "SN": { … }, "TF": { … }, "JP": { … }
  },
  "sourceConflicts": ["카톡과 행동 문항이 엇갈린 점 등, 없으면 []"],
  "candidateTypes": [
    { "type": "XXXX", "rank": 1, "confidence": 0, "reason": "1~2문장" },
    { "type": "YYYY", "rank": 2, "confidence": 0, "reason": "가장 약한 축을 뒤집은 이유" },
    { "type": "ZZZZ", "rank": 3, "confidence": 0, "reason": "…" }
  ],
  "overall": { "confidence": 0, "confidenceLevel": "HIGH|MEDIUM|LOW", "reason": "1문장" },
  "observerBiasNote": "관찰자 메모 편향 가능성 1문장 또는 null"
}`;

const PREMIUM_OUTPUT_SCHEMA = `{
  "tier": "premium",
  "mbtiType": "XXXX",
  "confidence": 60,
  "confidenceLevel": "MEDIUM",
  "confidenceReason": "1~2문장",
  "observedFeatures": ["6~7개, 각 1~2문장 — ‘인용’ → 관찰"],
  "axisAnalysis": {
    "EI": { "result": "E|I", "confidence": 0-100, "forEvidence": ["근거 1~2문장 (인용 포함)", "…", "…"], "againstEvidence": ["반대 근거", "…(선택)"] },
    "SN": { … }, "TF": { … }, "JP": { … }
  },
  "candidateTypes": [
    { "type": "XXXX", "rank": 1, "confidence": 60, "reason": "2~3문장" },
    { "type": "YYYY", "rank": 2, "confidence": 48, "reason": "2~3문장" },
    { "type": "ZZZZ", "rank": 3, "confidence": 38, "reason": "2~3문장" }
  ],
  "analysisExplanation": "5~8문장 — 순위 이유, 가장 강한 근거, 애매한 축, 맥락 반영",
  "boundaryNote": "2~4문장 — 판단 보류·약한 축, 근거 충돌",
  "analysisLimitations": "3~5문장 — 데이터 양, 맥락, 더 정확해지려면",
  "communicationTips": ["4~5개, 각 1~2문장 — 상황+행동"],
  "profileImageNote": "1~2문장 또는 빈 문자열",
  "oneLineConclusion": "1~2문장",
  "keyEvidenceSummary": [{ "snippet": "짧은 인용", "axis": "EI", "insight": "해석 1~2문장" }],
  "practicalTips": {
    "emotionVsDirect": "3~4문장",
    "effectiveCommunication": ["3~4개"],
    "whenHurt": ["3~4개"],
    "conflictAvoid": ["3~4개"],
    "scheduling": ["3~4개"]
  },
  "relationshipAndCommunication": {
    "summary": "4~6문장",
    "whenInterested": "2~3문장",
    "whenUncomfortable": "2~3문장",
    "whenClose": "2~3문장",
    "inConflict": "2~3문장",
    "replyAndEmoji": "2~3문장",
    "contactPreference": "2~3문장",
    "tips": ["5~6개"]
  },
  "workAndRoutine": { "summary": "4~5문장", "tips": ["5~7개"] },
  "cautionAndMisread": { "points": ["4~5개"] },
  "quotedInsights": [{ "quote": "짧은 인용", "insight": "해석" }],
  "tags": ["#태그1", "#태그2"]
}`;

const FREE_OUTPUT_SCHEMA = `{
  "tier": "free",
  "mbtiType": "1순위 4글자",
  "confidence": 0,
  "confidenceLevel": "MEDIUM|LOW",
  "observedFeatures": ["관찰 신호 5~6개, 각 1~2문장 — ‘인용’ → 관찰"],
  "axisAnalysis": {
    "EI": { "result": "E|I", "confidence": 0-100, "forEvidence": ["근거 2~3개 (인용 포함)"], "againstEvidence": ["반대 근거 1~2개"] },
    "SN": { … }, "TF": { … }, "JP": { … }
  },
  "candidateTypes": [
    { "type": "XXXX", "rank": 1, "confidence": 58, "reason": "2~3문장" },
    { "type": "YYYY", "rank": 2, "confidence": 46, "reason": "2~3문장" },
    { "type": "ZZZZ", "rank": 3, "confidence": 36, "reason": "2~3문장" }
  ],
  "analysisExplanation": "4~6문장",
  "boundaryNote": "2~3문장",
  "analysisLimitations": "2~4문장 — 데이터 양, 더 정확해지려면",
  "communicationTips": ["3~4개, 각 1~2문장 — 상황+행동"],
  "profileImageNote": "1문장 또는 빈 문자열",
  "tags": ["#태그1", "#태그2"]
}`;

// ─────────────────────────────────────────────
// 프롬프트 조립
// ─────────────────────────────────────────────

function roleLine(stage) {
  const roles = {
    extract:
      "당신은 카카오톡 캡처에서 한 사람의 말투와 행동 단서를 정확히 옮겨 적는 관찰자입니다. 이 단계에서는 MBTI 유형을 결론 내리지 않습니다.",
    judge:
      "당신은 정리된 단서만 보고 MBTI 4축을 판단하는 분석가입니다. 단서 목록에 없는 내용을 새로 만들어 내지 않습니다.",
    write:
      "당신은 판단 결과를 사용자가 읽기 쉬운 한국어 리포트로 쓰는 작가입니다. 판단 결과(유형·축 결과·숫자)는 바꾸지 않고, 근거를 실제 인용과 연결해 구체적으로 씁니다.",
    freeWrite:
      "당신은 정리된 단서만 보고 MBTI 4축을 판단한 뒤, 짧은 무료 리포트를 쓰는 분석가입니다. 단서 목록에 없는 내용을 새로 만들어 내지 않습니다.",
  };
  return roles[stage];
}

function systemFor(stage) {
  const sections = {
    extract: ["common", "extract", "signals"],
    judge: ["common", "signals", "judge"],
    write: ["common", "write", "profile"],
    freeWrite: ["common", "signals", "judge", "write", "profile"],
  }[stage];
  return `${roleLine(stage)}\n\n# 분석 지침\n\n${getGuide(sections)}\n\n# 출력\nJSON만 출력합니다. 설명 문장·마크다운 금지.`;
}

function contextBlock({ targetName, relationship, imageCount }) {
  const rel = relationship ? getRelationshipLabel(relationship) : "";
  return [
    `## 분석 대상`,
    `- 이름: ${targetName || "미지정"}`,
    rel ? `- 사용자와의 관계: ${rel}` : `- 사용자와의 관계: 알 수 없음`,
    imageCount != null ? `- 캡처 이미지: ${imageCount}장 (첨부 순서대로 1번부터)` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 추출 결과에서 다음 단계에 필요한 부분만 (토큰 절약) */
function compactExtraction(ex) {
  return {
    targetIdentified: ex?.targetIdentified,
    targetIdentifyNote: ex?.targetIdentifyNote ?? null,
    context: ex?.context ?? null,
    targetMessages: Array.isArray(ex?.targetMessages) ? ex.targetMessages.slice(0, 60) : [],
    otherMessages: Array.isArray(ex?.otherMessages) ? ex.otherMessages.slice(0, 40) : [],
    baseline: ex?.baseline ?? null,
    signals: Array.isArray(ex?.signals) ? ex.signals.slice(0, 40) : [],
    profileMood: ex?.profileMood ?? null,
    dataQuality: ex?.dataQuality ?? null,
  };
}

function observerBlock({ behaviorFormatted, memo }) {
  const blocks = [];
  if (behaviorFormatted && behaviorFormatted.trim()) {
    blocks.push(
      `## [D] 행동 객관식 문항 (관찰자가 고른 평소 모습)\n근거로 쓸 때는 "행동문항: 문항 이름" 형식으로 표시하세요.\n${behaviorFormatted}`,
    );
  }
  if (memo && memo.trim()) {
    blocks.push(`## [C] 관찰자 메모 (사용자가 직접 적은 내용)\n${memo.trim()}`);
  }
  return blocks.join("\n\n");
}

// ─────────────────────────────────────────────
// 결과 정리 (판단 결과와 최종 글의 일관성 보장)
// ─────────────────────────────────────────────

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/** 축 결과 4개로 유형 조합 */
function typeFromAxes(axes) {
  const letters = AXES.map((ax) => {
    const r = String(axes?.[ax]?.result || "").toUpperCase();
    return AXIS_LETTERS[ax].includes(r) ? r : null;
  });
  return letters.every(Boolean) ? letters.join("") : null;
}

function flipAxis(type, ax) {
  const i = AXES.indexOf(ax);
  const [a, b] = AXIS_LETTERS[ax];
  const ch = type[i] === a ? b : a;
  return type.slice(0, i) + ch + type.slice(i + 1);
}

/**
 * 후보 3개를 서로 다르게, 1순위는 축 결과 조합과 일치하게 맞춘다.
 * 2·3순위가 비거나 겹치면 가장 약한 축을 뒤집어 채운다.
 */
export function reconcileCandidates(axes, candidates) {
  const axisType = typeFromAxes(axes);
  const list = Array.isArray(candidates) ? [...candidates] : [];
  list.sort((a, b) => (a?.rank ?? 9) - (b?.rank ?? 9));

  const out = [];
  const seen = new Set();
  const push = (c) => {
    const t = String(c?.type || "").toUpperCase();
    if (!TYPE_RE.test(t) || seen.has(t)) return;
    seen.add(t);
    out.push({ ...c, type: t });
  };

  if (axisType) {
    const fromModel = list.find((c) => String(c?.type || "").toUpperCase() === axisType);
    push(fromModel || { type: axisType, reason: list[0]?.reason || "" });
  }
  // 2·3순위: 판단이 '강함'(75 이상)인 축을 뒤집은 후보는 쓰지 않는다 (지침 3-5)
  const flipsStrongAxis = (t) =>
    axisType &&
    AXES.some((ax, i) => t[i] !== axisType[i] && (axes?.[ax]?.confidence ?? 0) >= 75);
  list.forEach((c) => {
    const t = String(c?.type || "").toUpperCase();
    if (TYPE_RE.test(t) && !flipsStrongAxis(t)) push(c);
  });

  // 부족하면 약한 축 순서로 뒤집어서 채움
  if (axisType && out.length < 3) {
    const weakOrder = [...AXES].sort(
      (a, b) => (axes?.[a]?.confidence ?? 60) - (axes?.[b]?.confidence ?? 60),
    );
    for (const ax of weakOrder) {
      if (out.length >= 3) break;
      push({ type: flipAxis(axisType, ax), reason: `${ax} 축 판단이 상대적으로 약해 반대 방향도 가능해요.`, _filled: true });
    }
  }

  const top = out.slice(0, 3);
  // confidence 순서 보장 (1 ≥ 2 ≥ 3)
  let prev = 100;
  return top.map((c, i) => {
    let conf = clamp(c.confidence, 20, 90, i === 0 ? 60 : prev - 10);
    if (conf > prev) conf = prev - (i === 0 ? 0 : 5);
    prev = conf;
    return { ...c, rank: i + 1, confidence: conf };
  });
}

/** 후보 confidence가 1 ≥ 2 ≥ 3 순서가 되도록 (뒤 순위를 낮춤) */
function enforceDescending(list) {
  for (let i = 1; i < list.length; i++) {
    if (list[i].confidence >= list[i - 1].confidence) {
      list[i].confidence = Math.max(20, list[i - 1].confidence - 5);
    }
  }
  return list;
}

/** 판단 단계 결과를 검증·보정 */
function normalizeJudgment(j) {
  const axes = {};
  for (const ax of AXES) {
    const a = j?.axes?.[ax] || {};
    const r = String(a.result || "").toUpperCase();
    axes[ax] = {
      result: AXIS_LETTERS[ax].includes(r) ? r : AXIS_LETTERS[ax][0],
      strength: a.strength || "판단 보류",
      confidence: clamp(a.confidence, 50, 85, 55),
      forSignals: Array.isArray(a.forSignals) ? a.forSignals : [],
      againstSignals: Array.isArray(a.againstSignals) ? a.againstSignals : [],
      reasoning: a.reasoning || "",
    };
  }
  const candidateTypes = reconcileCandidates(axes, j?.candidateTypes);
  const overallConf = clamp(j?.overall?.confidence, 45, 82, candidateTypes[0]?.confidence ?? 60);
  const level = ["HIGH", "MEDIUM", "LOW"].includes(j?.overall?.confidenceLevel)
    ? j.overall.confidenceLevel
    : overallConf >= 75
      ? "HIGH"
      : overallConf >= 60
        ? "MEDIUM"
        : "LOW";
  if (candidateTypes[0]) candidateTypes[0].confidence = overallConf;
  // 코드가 채운 후보는 1순위 기준으로 10점씩 낮춤 (지침 3-6: 8~15 차이)
  candidateTypes.forEach((c, i) => {
    if (c._filled) c.confidence = Math.max(20, overallConf - 10 * i);
    delete c._filled;
  });
  enforceDescending(candidateTypes);
  return {
    axes,
    candidateTypes,
    sourceConflicts: Array.isArray(j?.sourceConflicts) ? j.sourceConflicts : [],
    overall: { confidence: overallConf, confidenceLevel: level, reason: j?.overall?.reason || "" },
    observerBiasNote: j?.observerBiasNote ?? null,
  };
}

/**
 * 최종 글에 판단 결과(유형·축 결과·숫자)를 덮어써서 일관성 보장
 */
export function applyJudgmentToReport(report, judgment, tier) {
  const out = report && typeof report === "object" ? { ...report } : {};
  out.tier = tier;
  out.mbtiType = judgment.candidateTypes[0]?.type || typeFromAxes(judgment.axes);
  out.confidence = judgment.overall.confidence;
  out.confidenceLevel = judgment.overall.confidenceLevel;
  if (tier === "premium" && !out.confidenceReason && judgment.overall.reason) {
    out.confidenceReason = judgment.overall.reason;
  }

  const axisAnalysis = { ...(out.axisAnalysis || {}) };
  for (const ax of AXES) {
    const prev = axisAnalysis[ax] || {};
    axisAnalysis[ax] = {
      ...prev,
      result: judgment.axes[ax].result,
      confidence: judgment.axes[ax].confidence,
      forEvidence: Array.isArray(prev.forEvidence) ? prev.forEvidence : [],
      againstEvidence: Array.isArray(prev.againstEvidence) ? prev.againstEvidence : [],
    };
  }
  out.axisAnalysis = axisAnalysis;

  const reasonsByType = new Map(
    (Array.isArray(out.candidateTypes) ? out.candidateTypes : []).map((c) => [
      String(c?.type || "").toUpperCase(),
      c?.reason,
    ]),
  );
  out.candidateTypes = judgment.candidateTypes.map((c) => ({
    type: c.type,
    rank: c.rank,
    confidence: c.confidence,
    reason: reasonsByType.get(c.type) || c.reason || "",
  }));
  return out;
}

/** 무료: 판단·작성을 한 번에 한 결과에서 판단 부분을 뽑아 정리 */
function judgmentFromFreeReport(report) {
  const axes = {};
  for (const ax of AXES) {
    const a = report?.axisAnalysis?.[ax] || {};
    axes[ax] = { result: a.result, confidence: a.confidence };
  }
  return normalizeJudgment({
    axes,
    candidateTypes: report?.candidateTypes,
    overall: { confidence: report?.confidence, confidenceLevel: report?.confidenceLevel },
  });
}

// ─────────────────────────────────────────────
// 단계 실행
// ─────────────────────────────────────────────

async function runExtract({ tier, targetName, relationship, images, deadline }) {
  const parts = [
    {
      text:
        `${contextBlock({ targetName, relationship, imageCount: images.length })}\n\n` +
        `아래 캡처에서 분석 대상의 메시지와 단서를 지침 1장·2장에 따라 정리하세요.`,
    },
    ...imagesToParts(images),
    { text: `## 출력 스키마 (JSON만)\n${EXTRACT_SCHEMA}` },
  ];
  return generateJson({
    tier,
    system: systemFor("extract"),
    parts,
    temperature: 0.1,
    maxOutputTokens: 12288,
    timeoutMs: STAGE_TIMEOUT[tier].extract,
    deadline,
    label: "extract",
  });
}

async function runJudge({ targetName, relationship, extraction, behaviorFormatted, memo, deadline }) {
  const parts = [
    {
      text: [
        contextBlock({ targetName, relationship }),
        `## [A] 단서 추출 결과\n${JSON.stringify(compactExtraction(extraction))}`,
        observerBlock({ behaviorFormatted, memo }),
        `지침 3장에 따라 4축을 판단하고 후보 3개와 confidence를 정하세요. confidence 숫자는 3-6 표의 범위에서만 고르세요.`,
        `## 출력 스키마 (JSON만)\n${JUDGE_SCHEMA}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
  return generateJson({
    tier: MODEL_TIER.PREMIUM,
    system: systemFor("judge"),
    parts,
    temperature: 0.15,
    maxOutputTokens: 8192,
    timeoutMs: STAGE_TIMEOUT.premium.judge,
    deadline,
    label: "judge",
  });
}

async function runPremiumWrite({ targetName, relationship, extraction, judgment, behaviorFormatted, memo, deadline }) {
  const parts = [
    {
      text: [
        contextBlock({ targetName, relationship }),
        `## [A] 단서 추출 결과 (인용은 여기 있는 메시지만 사용)\n${JSON.stringify(compactExtraction(extraction))}`,
        observerBlock({ behaviorFormatted, memo }),
        `## 판단 결과 (바꾸지 말 것)\n${JSON.stringify(judgment)}`,
        `지침 5장에 따라 사용자에게 보여줄 리포트를 쓰세요.\n` +
          `- mbtiType, 각 축 result·confidence, candidateTypes의 type·rank·confidence는 판단 결과와 똑같이 옮기세요.\n` +
          `- forEvidence·againstEvidence는 판단 결과의 forSignals·againstSignals에 해당하는 단서를 인용과 함께 풀어 쓰세요. 축당 forEvidence 2~3개, againstEvidence 1~2개.\n` +
          `- 판단 보류·약함인 축과 근거 충돌(sourceConflicts)은 boundaryNote에 분명히 쓰세요.\n` +
          `- 문장·근거 중복 금지. keyEvidenceSummary 최대 5개, quotedInsights 최대 3개.`,
        `## 출력 스키마 (JSON만)\n${PREMIUM_OUTPUT_SCHEMA}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
  return generateJson({
    tier: MODEL_TIER.PREMIUM,
    system: systemFor("write"),
    parts,
    temperature: 0.4,
    maxOutputTokens: 16384,
    timeoutMs: STAGE_TIMEOUT.premium.write,
    deadline,
    label: "write",
  });
}

async function runFreeWrite({ targetName, extraction, deadline }) {
  const parts = [
    {
      text: [
        contextBlock({ targetName }),
        `## [A] 단서 추출 결과 (인용은 여기 있는 메시지만 사용)\n${JSON.stringify(compactExtraction(extraction))}`,
        `무료 빠른 추정입니다. 관계·행동 문항 없이 캡처 단서만으로 판단하므로 confidence는 보수적으로(3-6 표 범위 안, 1순위 최대 72) 잡으세요.\n` +
          `지침 3장으로 4축을 판단한 뒤, 지침 5장에 따라 짧은 리포트를 쓰세요. 근거마다 인용을 붙이세요.`,
        `## 출력 스키마 (JSON만)\n${FREE_OUTPUT_SCHEMA}`,
      ].join("\n\n"),
    },
  ];
  return generateJson({
    tier: MODEL_TIER.FREE,
    system: systemFor("freeWrite"),
    parts,
    temperature: 0.3,
    maxOutputTokens: 10240,
    timeoutMs: STAGE_TIMEOUT.free.write,
    deadline,
    label: "free-write",
  });
}

/**
 * @param {{
 *   mode: string,
 *   targetName?: string,
 *   memo?: string,
 *   images: Array<{ base64Data: string, mimeType?: string }>,
 *   relationship?: string|null,
 *   behaviorFormatted?: string,
 *   debug?: boolean,
 * }} input
 */
export async function runAnalysisPipeline({
  mode,
  targetName,
  memo = "",
  images,
  relationship = null,
  behaviorFormatted = "",
  debug = false,
}) {
  const tier = mode === ANALYSIS_MODE.PREMIUM ? "premium" : "free";
  const deadline = Date.now() + TOTAL_BUDGET[tier];
  const trace = { tier, stages: [] };

  const ex = await runExtract({ tier, targetName, relationship, images, deadline });
  trace.stages.push({ stage: "extract", model: ex.model, ms: ex.ms });
  const extraction = ex.json;

  let report;
  let judgment;

  if (tier === "premium") {
    const jd = await runJudge({ targetName, relationship, extraction, behaviorFormatted, memo, deadline });
    trace.stages.push({ stage: "judge", model: jd.model, ms: jd.ms });
    judgment = normalizeJudgment(jd.json);

    const wr = await runPremiumWrite({
      targetName,
      relationship,
      extraction,
      judgment,
      behaviorFormatted,
      memo,
      deadline,
    });
    trace.stages.push({ stage: "write", model: wr.model, ms: wr.ms });
    report = applyJudgmentToReport(wr.json, judgment, "premium");
  } else {
    const fw = await runFreeWrite({ targetName, extraction, deadline });
    trace.stages.push({ stage: "free-write", model: fw.model, ms: fw.ms });
    judgment = judgmentFromFreeReport(fw.json);
    // 무료는 캡처만 보므로 확신도 상한을 둔다
    if (judgment.overall.confidence > FREE_MAX_CONFIDENCE) {
      judgment.overall.confidence = FREE_MAX_CONFIDENCE;
      judgment.candidateTypes[0].confidence = FREE_MAX_CONFIDENCE;
      enforceDescending(judgment.candidateTypes);
    }
    if (judgment.overall.confidenceLevel === "HIGH") judgment.overall.confidenceLevel = "MEDIUM";
    report = applyJudgmentToReport(fw.json, judgment, "free");
  }

  if (debug) {
    report._debug = { trace, extraction, judgment };
  }
  return report;
}
