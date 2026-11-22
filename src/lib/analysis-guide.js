import { readFileSync } from "fs";
import { join } from "path";

/**
 * 분석 지침서(docs/mbti_skills_v2.md)를 단계별 프롬프트용으로 잘라 제공합니다.
 *
 * 지침서 안의 `<!-- @section 이름 -->` ~ `<!-- @end -->` 구간이 하나의 섹션입니다.
 * 섹션 이름: common, extract, signals, judge, profile, write
 */

const GUIDE_PATH = ["docs", "mbti_skills_v2.md"];

/** @type {Record<string, string> | null} */
let cachedSections = null;

/**
 * @param {string} raw
 * @returns {Record<string, string>}
 */
export function parseGuideSections(raw) {
  /** @type {Record<string, string>} */
  const map = {};
  const re = /<!--\s*@section\s+([a-z0-9_-]+)\s*-->([\s\S]*?)<!--\s*@end\s*-->/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    map[m[1].toLowerCase()] = m[2].trim();
  }
  return map;
}

function loadSections() {
  if (cachedSections) return cachedSections;
  const raw = readFileSync(join(process.cwd(), ...GUIDE_PATH), "utf-8");
  const sections = parseGuideSections(raw);
  const required = ["common", "extract", "signals", "judge", "write"];
  const missing = required.filter((k) => !sections[k]);
  if (missing.length) {
    throw new Error(
      `분석 지침서 섹션 누락: ${missing.join(", ")} (docs/mbti_skills_v2.md 확인)`,
    );
  }
  cachedSections = sections;
  return sections;
}

/**
 * @param {string[]} names
 * @returns {string}
 */
export function getGuide(names) {
  const sections = loadSections();
  return names
    .map((n) => sections[n])
    .filter(Boolean)
    .join("\n\n---\n\n");
}

/** 테스트용: 캐시 초기화 */
export function resetGuideCache() {
  cachedSections = null;
}
