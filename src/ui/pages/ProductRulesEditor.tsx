import { useState } from "react";
import { ProductRulesFileSchema, type ProductRule } from "@/core/productRules";
import { downloadJson, errMsg, pickJsonFile } from "../app";

const newRule = (): ProductRule => ({
  id: `rule_${Date.now().toString(36)}`,
  name: "",
  keywords: [],
  accent: null,
  colorReason: "",
  composition: "",
  maxHeadline: null,
  note: "",
});

/**
 * 설정 > 제품 종류별 규칙. 사람이 광고 경험으로 정한 색·구도·문구 길이를 적는다.
 * 1부 1번(무엇을 파시나요) 답에 키워드가 있으면 아이디어·이미지 프롬프트에 참고로 들어가고,
 * 합성의 첫 버튼 색과 헤드라인 길이 점검에 쓰인다. 앱이 규칙 내용을 지어내지는 않는다.
 */
export function ProductRulesEditor({ rules, onChange }: { rules: ProductRule[]; onChange: (r: ProductRule[]) => void }) {
  const [msg, setMsg] = useState("");
  const patch = (i: number, p: Partial<ProductRule>) => onChange(rules.map((r, k) => (k === i ? { ...r, ...p } : r)));
  const incomplete = rules.filter((r) => !r.name.trim() || r.keywords.length === 0).length;

  return (
    <div className="card small stack">
      <h3>제품 종류별 규칙</h3>
      <p className="muted" style={{ margin: 0 }}>
        예: 착즙기 → 신선함이라 초록. 1부 1번 답에 키워드가 있으면 아이디어·이미지 프롬프트에 참고로 넣고, 합성의 시안 A 버튼 색과 헤드라인 길이 점검에 씁니다.
        규칙 내용은 사람이 정합니다 (앱이 지어내지 않음). 이 브라우저에만 저장되므로 팀과 나누려면 내보내기 파일을 쓰세요.
      </p>
      {rules.length === 0 && <p className="muted" style={{ margin: 0 }}>아직 규칙이 없습니다. 규칙이 없으면 앱 기본 색을 씁니다.</p>}
      {rules.map((r, i) => (
        <div key={r.id} className="card stack" style={{ background: "var(--bg)" }}>
          <div className="row">
            <label className="row">이름 <input type="text" style={{ width: 140 }} placeholder="예: 착즙기" value={r.name} onChange={(e) => patch(i, { name: e.target.value })} /></label>
            <label className="row" style={{ flex: 1 }}>키워드 (쉼표로)
              <input
                type="text"
                style={{ flex: 1, minWidth: 160 }}
                placeholder="예: 착즙기, 주서기, 주스"
                defaultValue={r.keywords.join(", ")}
                onBlur={(e) => patch(i, { keywords: e.target.value.split(",").map((k) => k.trim()).filter(Boolean).slice(0, 20) })}
              />
            </label>
            <button className="small" onClick={() => onChange(rules.filter((_, k) => k !== i))}>지우기</button>
          </div>
          <div className="row">
            <label className="row"><input type="checkbox" checked={!!r.accent} onChange={(e) => patch(i, { accent: e.target.checked ? "#3a8f3a" : null })} /> 강조색</label>
            {r.accent && <input type="color" value={r.accent} onChange={(e) => patch(i, { accent: e.target.value })} />}
            <input type="text" style={{ flex: 1, minWidth: 180 }} placeholder="색을 고른 이유 (예: 신선함)" value={r.colorReason} onChange={(e) => patch(i, { colorReason: e.target.value })} />
            <label className="row">헤드라인 최대
              <input type="text" inputMode="numeric" style={{ width: 70 }} placeholder="없음" value={r.maxHeadline ?? ""} onChange={(e) => { const n = e.target.value.replace(/\D/g, ""); patch(i, { maxHeadline: n ? Math.max(4, Math.min(60, Number(n))) : null }); }} />자
            </label>
          </div>
          <input type="text" placeholder="구도·배치 메모 (예: 제품을 크게, 과일·채소를 함께, 밝은 주방)" value={r.composition} onChange={(e) => patch(i, { composition: e.target.value })} />
          {(!r.name.trim() || r.keywords.length === 0) && <span className="warn">이름과 키워드를 넣어야 규칙이 쓰입니다</span>}
        </div>
      ))}
      <div className="row">
        <button onClick={() => onChange([...rules, newRule()])}>규칙 추가</button>
        <button disabled={rules.length === 0} onClick={() => downloadJson("제품종류규칙.json", { format: "ad-agent-product-rules", version: 1, rules })}>내보내기</button>
        <button
          onClick={async () => {
            setMsg("");
            try {
              const parsed = ProductRulesFileSchema.safeParse(await pickJsonFile());
              if (!parsed.success) throw new Error("제품 종류 규칙 파일이 아닙니다");
              const ids = new Set(rules.map((r) => r.id));
              onChange([...rules, ...parsed.data.rules.filter((r) => !ids.has(r.id))]);
              setMsg(`${parsed.data.rules.length}개를 가져왔습니다. 아래 '저장'을 눌러야 적용됩니다`);
            } catch (e) {
              setMsg(errMsg(e));
            }
          }}
        >
          가져오기
        </button>
        {incomplete > 0 && <span className="warn">미완성 규칙 {incomplete}개</span>}
      </div>
      {msg && <span className="muted">{msg}</span>}
      <span className="muted">바꾼 규칙은 이후 새로 만드는 아이디어·프롬프트·합성에 적용됩니다 (이미 만든 합성의 버튼 색은 그대로).</span>
    </div>
  );
}
