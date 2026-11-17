import { normalizeMbtiCode } from "@/lib/result-evidence-helpers";
import { confidenceLevelToKorean } from "@/lib/result-confidence";
import styles from "./ResultLabTheme.module.css";

const LETTER_LABELS = {
  E: "외향", I: "내향", S: "감각", N: "직관",
  T: "사고", F: "감정", J: "판단", P: "인식",
};

export default function LabResultHero({
  mbtiType, targetName, title, conclusion, confidenceLevel, isPremium, tags,
}) {
  const code = normalizeMbtiCode(mbtiType);
  const hasConfidence = /^(HIGH|MEDIUM|LOW)$/i.test(String(confidenceLevel || ""));

  return (
    <section className={styles.hero} aria-labelledby="lab-result-heading">
      <div className={styles.heroTop}>
        <span className={styles.wordmark}>MINDPICK <span>성향 연구소</span></span>
        <span className={styles.tier}>{isPremium ? "PREMIUM · 심층 리포트" : "FREE · 빠른 추정"}</span>
      </div>
      <p className={styles.eyebrow}>대화 속 단서로 읽는 그 사람</p>
      <h1 id="lab-result-heading" className={styles.heading}>
        {targetName?.trim() ? <>{targetName}님의<br /></> : <>그 사람의<br /></>}
        {code ? "가장 유력한 MBTI는?" : "MBTI를 아직 좁히기 어려워요"}
      </h1>
      <div className={styles.letters} role="img" aria-label={code ? `추정 유형 ${code}` : "유형 판단 보류"}>
        {(code || "????").split("").map((letter, i) => (
          <div key={i} className={styles.letter} aria-hidden="true">
            <span>{letter}</span><small>{LETTER_LABELS[letter] || "단서 부족"}</small>
          </div>
        ))}
      </div>
      {title && <p className={styles.typeTitle}>{title}</p>}
      {conclusion?.trim() && <p className={styles.conclusion}>{conclusion}</p>}
      <div className={styles.heroFooter}>
        <span className={styles.signal}><i aria-hidden="true" />{hasConfidence ? `종합 확신 · ${confidenceLevelToKorean(confidenceLevel)}` : "입력된 단서를 바탕으로 한 추정"}</span>
        <span>유형은 단정하지 않아요</span>
      </div>
      {Array.isArray(tags) && tags.length > 0 && (
        <ul className={styles.tags} aria-label="관찰된 성향 키워드">
          {tags.slice(0, 6).map((tag, i) => <li key={i}>{tag}</li>)}
        </ul>
      )}
    </section>
  );
}
