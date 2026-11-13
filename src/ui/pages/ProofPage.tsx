import { useState } from "react";
import { SIZES, SIZE_LABEL, type BaseSize, type Variant } from "@/core/compose";
import { ProofFileSchema, REVISION_KINDS, type ProofAnswer, type ProofFile, type RevisionKind } from "@/core/delivery";
import { downloadJson, errMsg, pickJsonFile } from "../app";

type Choice = "A" | "B" | "revise";

/**
 * 광고주용 시안 확인 화면 (#/proof). 로그인 없이 휴대폰에서 연다.
 * 받은 시안 확인 파일을 이 브라우저에서만 열어 보고, 답변 파일을 내려받아 담당자에게 돌려준다.
 * 아무것도 서버로 보내거나 저장하지 않는다.
 */
export function ProofPage() {
  const [proof, setProof] = useState<ProofFile | null>(null);
  const [err, setErr] = useState("");
  const [size, setSize] = useState<BaseSize>("1080x1080");
  const [choice, setChoice] = useState<Choice | null>(null);
  const [base, setBase] = useState<Variant | null>(null);
  const [requests, setRequests] = useState<Partial<Record<RevisionKind, string>>>({});
  const [comment, setComment] = useState("");
  const [done, setDone] = useState(false);
  const [opening, setOpening] = useState(false);

  const open = async () => {
    setErr("");
    setOpening(true);
    try {
      const parsed = ProofFileSchema.safeParse(await pickJsonFile(60));
      if (!parsed.success) throw new Error("시안 확인 파일이 아닙니다. 담당자에게 받은 파일을 골라 주세요");
      setProof(parsed.data);
      setChoice(null);
      setRequests({});
      setComment("");
      setDone(false);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setOpening(false);
    }
  };

  const kinds = Object.keys(requests) as RevisionKind[];
  const canSend = choice === "A" || choice === "B" || (choice === "revise" && kinds.length > 0 && kinds.every((k) => requests[k]!.trim()));

  const send = () => {
    if (!proof || !choice) return;
    const answer: ProofAnswer = {
      format: "ad-agent-proof-answer",
      version: 1,
      proofId: proof.proofId,
      caseId: proof.caseId,
      answeredAt: new Date().toISOString(),
      decision: choice === "revise" ? "revise" : "confirm",
      variant: choice === "revise" ? base : choice,
      requests: choice === "revise" ? kinds.map((k) => ({ kind: k, detail: requests[k]!.trim() })) : [],
      comment: comment.trim(),
    };
    downloadJson(`시안답변_${proof.company}_${proof.round}차.json`, answer);
    setDone(true);
  };

  return (
    <main className="wrap proof">
      <h1>시안 확인</h1>
      {!proof ? (
        <div className="card stack">
          <p style={{ margin: 0 }}>담당자에게 받은 <b>시안 확인 파일</b>(.json)을 열어 주세요. 파일은 이 휴대폰(브라우저) 안에서만 열리고 어디에도 올라가지 않습니다.</p>
          <button className="primary" disabled={opening} onClick={open}>{opening ? "여는 중…" : "시안 확인 파일 열기"}</button>
          {err && <p className="err" style={{ margin: 0 }}>⚠ {err}</p>}
        </div>
      ) : (
        <div className="stack">
          <div className="card small">
            <b>{proof.company}</b> · {proof.round}차 시안
            <div style={{ marginTop: 4 }}>{proof.note}</div>
          </div>

          <div className="row small">
            {SIZES.filter((s) => proof.variants.A.images[s]).map((s) => (
              <button key={s} className={size === s ? "primary" : ""} onClick={() => setSize(s)}>{SIZE_LABEL[s]}</button>
            ))}
          </div>

          <div className="proof-grid">
            {(["A", "B"] as const).map((v) => {
              const pv = proof.variants[v];
              const on = choice === v;
              return (
                <div key={v} className={`card stack small ${on ? "picked" : ""}`}>
                  <b>시안 {v}</b>
                  {pv.images[size] && <img src={pv.images[size]} alt={`시안 ${v} ${size}`} style={{ width: "100%", border: "1px solid var(--line)" }} />}
                  <div><span className="muted">문구</span> {pv.headline.replace(/\n/g, " ")}</div>
                  {pv.sub && <div><span className="muted">서브</span> {pv.sub}</div>}
                  <div><span className="muted">버튼</span> {pv.cta}</div>
                  <button className={on ? "primary" : ""} disabled={done} onClick={() => setChoice(v)}>{on ? `✓ 시안 ${v}로 확정` : `시안 ${v}로 확정`}</button>
                </div>
              );
            })}
          </div>

          <div className="card"><fieldset disabled={done} className="plain stack small">
            <label className="row"><input type="radio" checked={choice === "revise"} disabled={done} onChange={() => setChoice("revise")} /> <b>수정을 요청합니다</b></label>
            {choice === "revise" && (
              <>
                <div className="row">
                  기준 시안
                  {(["A", "B"] as const).map((v) => (
                    <label key={v} className="row"><input type="radio" checked={base === v} onChange={() => setBase(v)} /> {v}</label>
                  ))}
                  <label className="row"><input type="radio" checked={base === null} onChange={() => setBase(null)} /> 정하지 않음</label>
                </div>
                <div className="muted">고칠 부분을 고르고 어떻게 바꾸고 싶은지 적어 주세요.</div>
                {REVISION_KINDS.map((k) => (
                  <div key={k} className="stack" style={{ gap: 4 }}>
                    <label className="row">
                      <input
                        type="checkbox"
                        checked={k in requests}
                        onChange={(e) => {
                          const next = { ...requests };
                          if (e.target.checked) next[k] = "";
                          else delete next[k];
                          setRequests(next);
                        }}
                      />
                      {k}
                    </label>
                    {k in requests && (
                      <input type="text" placeholder={k === "글자" ? "예: 헤드라인을 더 짧게" : k === "이미지 교체" ? "예: 더 밝은 사진으로" : "어떻게 바꿀지"} value={requests[k]} onChange={(e) => setRequests({ ...requests, [k]: e.target.value })} />
                    )}
                    {k === "콘셉트 변경" && k in requests && (
                      <div className="warn">콘셉트 변경은 수정이 아니라 새 시안으로 처리되어, 일정·비용을 따로 협의할 수 있습니다.</div>
                    )}
                  </div>
                ))}
              </>
            )}
          </fieldset></div>

          <label className="field small"><span>하고 싶은 말 (선택)</span><textarea style={{ minHeight: 60 }} disabled={done} value={comment} onChange={(e) => setComment(e.target.value)} /></label>

          {!done ? (
            <button className="primary" disabled={!canSend} onClick={send}>
              {choice === "A" || choice === "B" ? `시안 ${choice}로 확정하고 답변 파일 받기` : "수정 요청 답변 파일 받기"}
            </button>
          ) : (
            <div className="card okc stack">
              <b>답변 파일을 내려받았습니다.</b>
              <span>내려받은 파일(시안답변_….json)을 담당자에게 보내 주세요 (카카오톡, 메일 등).</span>
              <button className="small" onClick={() => setDone(false)}>답변 고치기</button>
            </div>
          )}
          <button className="small" onClick={open}>다른 시안 확인 파일 열기</button>
          {err && <p className="err" style={{ margin: 0 }}>⚠ {err}</p>}
        </div>
      )}
    </main>
  );
}
