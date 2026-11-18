import { ANALYSIS_MODE } from "./analysis-tier";
import { formatBehaviorAnswers } from "@/lib/format-behavior-answers";
import { isDevModeServer } from "@/lib/dev-mode";
import { runAnalysisPipeline } from "./analysis-pipeline";

/**
 * 분석 진입점 (API 라우트에서 호출)
 *
 * 실제 분석은 analysis-pipeline.js 의 단계별 파이프라인이 수행한다.
 * - 무료: 단서 추출 → 판단·작성 (무료 모델)
 * - 유료: 단서 추출 → 판단 → 작성 (유료 모델)
 * 모델 선택·재시도는 gemini-client.js, 판단 지침은 docs/mbti_skills_v2.md.
 *
 * @param {{ targetName?: string, memo?: string, images: Array, mode?: string, relationship?: string|null, behaviorAnswers?: Record<string, string> }} opts
 */
export async function callGemini({
  targetName,
  memo,
  images,
  mode = ANALYSIS_MODE.FREE,
  relationship,
  behaviorAnswers,
}) {
  const isPremium = mode === ANALYSIS_MODE.PREMIUM;
  return runAnalysisPipeline({
    mode: isPremium ? ANALYSIS_MODE.PREMIUM : ANALYSIS_MODE.FREE,
    targetName,
    memo: isPremium ? (memo && String(memo).trim()) || "" : "",
    images: images || [],
    relationship: isPremium ? relationship || null : null,
    behaviorFormatted: isPremium ? formatBehaviorAnswers(behaviorAnswers || {}) : "",
    debug: isDevModeServer(),
  });
}
