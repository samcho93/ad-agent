import { useEffect, useMemo, useState } from "react";
import { DeliveryService } from "@/core/deliveryService";
import type { ComposeDoc } from "@/core/compose";
import type { RevisionRecord } from "@/core/delivery";
import { LAYOUT_FIELD_LABEL, applySuggestion, currentValue, type LayoutSuggestion, type RevisionDraft } from "@/core/revision";
import { generateRevisionDraft, openRevision, readRevisionDraft } from "@/llm/revisionPipeline";
import { PROVIDER_LABEL } from "@/llm/select";
import { errMsg, useApp } from "../app";

const isColor = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);
const Swatch = ({ c }: { c: string }) =>
  isColor(c) ? <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 3, background: c, border: "1px solid var(--line)", verticalAlign: "middle", marginRight: 3 }} /> : null;

/**
 * 광고주 수정 요청이 열려 있으면 합성 화면 위에 보여 주고, AI 수정안(문구 후보·배치·색 조정값)을 만든다.
 * 수정안은 고른 것만 화면의 합성 명세에 반영된다. 저장·PNG·검수는 평소대로 사람이 한다.
 */
export function RevisionAssist({ caseId, doc, locked, onApply }: { caseId: string; doc: ComposeDoc; locked: boolean; onApply: (d: ComposeDoc) => void }) {
  const { svc, generator, settings } = useApp();
  const dsvc = useMemo(() => new DeliveryService(svc), [svc]);
  const [rev, setRev] = useState<RevisionRecord | null>(null);
  const [round, setRound] = useState(0);
  const [draft, setDraft] = useState<RevisionDraft | null>(null);
  /** 적용한 제안 → 적용 전 값 */
  const [applied, setApplied] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      const d = await dsvc.getDoc(caseId);
      const r = openRevision(d);
      const saved = r ? await readRevisionDraft(svc, caseId) : null;
      if (!alive) return;
      setRev(r);
      setRound(d.proofs.length);
      setDraft(saved && r && saved.revisionAt === r.at ? saved : null);
    })().catch(() => {});
    return () => { alive = false; };
  }, [caseId, dsvc, svc]);

  if (!rev || locked) return null;

  const make = async () => {
    setBusy(true);
    setErr("");
    try {
      setDraft(await generateRevisionDraft(svc, caseId, generator(), doc, rev));
      setApplied(new Map());
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const mark = (k: string, before = "") => setApplied((m) => new Map(m).set(k, before));
  const applyLayout = (list: { s: LayoutSuggestion; k: string }[]) => {
    let d = doc;
    const befores = list.map(({ s }) => currentValue(doc, s.field, s.variant));
    for (const { s } of list) d = applySuggestion(d, s);
    onApply(d);
    list.forEach(({ k }, i) => mark(k, befores[i]));
  };
  const layoutKeys = (draft?.layout ?? []).map((s, i) => ({ s, k: `l${i}` }));

  return (
    <div className="card stack small" style={{ borderColor: "var(--accent)" }}>
      <b>광고주 수정 요청 반영 중 ({round}차 시안에 대한 {rev.source} 요청 · {rev.type})</b>
      <div>
        <span className="tag estimate">{rev.kinds.join(", ")}</span> {rev.detail || "(내용 없음)"}
      </div>
      <div className="row">
        <button className="primary" disabled={busy} onClick={make}>{busy ? "수정안 만드는 중…" : draft ? "AI 수정안 다시 만들기" : "AI 수정안 만들기"}</button>
        <span className="muted">{PROVIDER_LABEL[settings.llm.provider]}로 문구 후보와 색·위치 조정값을 제안받습니다 (LLM 비용 있음). 고른 것만 반영되고, 자동으로 바뀌지 않습니다.</span>
      </div>
      {err && <p className="err" style={{ margin: 0 }}>⚠ {err}</p>}

      {draft && (
        <div className="stack">
          <div className="muted"><span className="tag ai">AI 초안</span> {draft.model} · {new Date(draft.createdAt).toLocaleString("ko-KR")}</div>
          {draft.needsHuman && <div className="warn">사람이 할 일: {draft.needsHuman}</div>}

          {draft.copyOptions.length > 0 && <div><b>문구 후보</b></div>}
          {draft.copyOptions.map((o, i) => {
            const k = `c${i}`;
            const blocked = o.issues.some((x) => x.severity === "error");
            return (
              <div key={k} className="card stack" style={{ background: "var(--bg)" }}>
                <div className="muted">시안 {o.variant} · {o.reason}</div>
                {o.patch.lead && <div><span className="muted">리드</span> {o.patch.lead}</div>}
                <div><span className="muted">헤드라인</span> <b style={{ whiteSpace: "pre-line" }}>{o.patch.headline}</b></div>
                <div><span className="muted">서브</span> {o.patch.sub}</div>
                <div><span className="muted">버튼</span> {o.patch.cta}</div>
                {o.issues.map((x, j) => <div key={j} className={x.severity === "error" ? "err" : "warn"}>⚠ {x.message}</div>)}
                <div className="row">
                  <button
                    className="small"
                    disabled={blocked || applied.has(k)}
                    onClick={() => {
                      const d = structuredClone(doc);
                      Object.assign(d.variants[o.variant], o.patch);
                      onApply(d);
                      mark(k);
                    }}
                  >
                    {applied.has(k) ? "적용함" : `시안 ${o.variant}에 이 문구 적용`}
                  </button>
                  {blocked && <span className="err">오류가 있어 적용할 수 없습니다</span>}
                </div>
              </div>
            );
          })}

          {layoutKeys.length > 0 && (
            <>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <b>색·위치·크기 조정</b>
                <button className="small" disabled={layoutKeys.every(({ k }) => applied.has(k))} onClick={() => applyLayout(layoutKeys.filter(({ k }) => !applied.has(k)))}>모두 적용</button>
              </div>
              {layoutKeys.map(({ s, k }) => {
                const now = applied.has(k) ? applied.get(k)! : currentValue(doc, s.field, s.variant);
                return (
                  <div key={k} className="row">
                    <span>
                      {LAYOUT_FIELD_LABEL[s.field]}{s.variant !== "공통" ? ` (시안 ${s.variant})` : " (A/B 공통)"}: <Swatch c={now} />{now} → <Swatch c={String(s.value)} /><b>{String(s.value)}</b>
                      <span className="muted"> · {s.reason}</span>
                    </span>
                    <button className="small" disabled={applied.has(k)} onClick={() => applyLayout([{ s, k }])}>{applied.has(k) ? "적용함" : "적용"}</button>
                  </div>
                );
              })}
            </>
          )}
          {draft.dropped.length > 0 && <div className="muted">쓰지 않은 제안: {draft.dropped.join(" / ")}</div>}
          {draft.copyOptions.length === 0 && layoutKeys.length === 0 && !draft.needsHuman && <div className="muted">제안이 없습니다. 요청 내용을 보고 직접 고쳐 주세요.</div>}
          <div className="muted">적용한 뒤 미리보기와 점검을 확인하고 '변경 저장' 또는 'PNG 저장'을 누르세요. 저장 후 다시 검수 → 게이트 2 → 광고주 확인을 거칩니다.</div>
        </div>
      )}
    </div>
  );
}
