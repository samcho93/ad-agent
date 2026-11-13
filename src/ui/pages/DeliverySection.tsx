import { useCallback, useEffect, useMemo, useState } from "react";
import { DeliveryService, type DeliveryReadiness } from "@/core/deliveryService";
import { renderFile } from "@/core/composeService";
import { reached, type CaseStatus } from "@/core/caseService";
import { REVISION_KINDS, type DeliveryDoc, type FinalReview, type RevisionKind, revisionCount, revisionType } from "@/core/delivery";
import { VariantSizes } from "./VariantSizes";
import { downloadBytes, downloadJson, errMsg, href, pickJsonFile, useApp } from "../app";

/** 게이트 2 뒤: 광고주 시안 확인(파일) → 완성본 심의(심의 업종) → 납품 ZIP. 수정 요청 기록 */
export function DeliverySection({ caseId, company, name, status, onChanged }: { caseId: string; company: string; name: string; status: CaseStatus; onChanged: () => void }) {
  const { svc, store, settings } = useApp();
  const dsvc = useMemo(() => new DeliveryService(svc), [svc]);
  const [doc, setDoc] = useState<DeliveryDoc | null>(null);
  const [ready, setReady] = useState<DeliveryReadiness | null>(null);
  const [media, setMedia] = useState<{ size: string; maxKB: number | null }>({ size: "", maxKB: null });
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    setDoc(await dsvc.getDoc(caseId));
    const m = (await svc.getIntake(caseId)).answers["11"];
    setMedia({ size: m.size, maxKB: m.maxKB });
    setReady(await dsvc.readiness(caseId));
  }, [dsvc, caseId]);
  useEffect(() => {
    reload().catch((e) => setErr(errMsg(e)));
  }, [reload, status]);

  // 고른 시안 미리보기
  const picked = doc?.delivered?.variant ?? doc?.selectedVariant ?? null;
  useEffect(() => {
    if (!picked) return setThumbs({});
    let alive = true;
    const made: string[] = [];
    (async () => {
      const out: Record<string, string> = {};
      for (const s of ["1080x1080", "1200x628", "320x100"] as const) {
        const b = await store.readBlob(caseId, renderFile(picked, s));
        if (b) made.push((out[s] = URL.createObjectURL(b)));
      }
      if (alive) setThumbs(out);
    })();
    return () => {
      alive = false;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [picked, caseId, store]);

  const run = async (label: string, work: () => Promise<unknown>) => {
    if (!name.trim()) return setErr("위쪽 '내 이름'을 먼저 적어 주세요 (기록에 남습니다)");
    setBusy(label);
    setErr("");
    try {
      await work();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      await reload().catch(() => {});
      setBusy("");
      onChanged();
    }
  };

  if (!doc || !ready) return <p className="muted">불러오는 중…</p>;
  // 게이트 2 전: 처음이면 안내만, 수정 중이면 마지막 요청과 기록을 보여 준다
  const before = !reached(status, "gate2_approved");
  if (before && doc.proofs.length === 0 && doc.revisions.length === 0) return <p className="small muted">게이트 2를 통과하면 광고주에게 시안을 보낼 수 있습니다.</p>;
  const lastRev = doc.revisions.at(-1);
  const count = revisionCount(doc, settings.revision.includedCount);
  const latest = doc.proofs.at(-1);
  const latestAnswer = latest ? doc.answers.find((a) => a.proofId === latest.id) : undefined;
  const proofLink = `${location.origin}${location.pathname}${href("proof")}`;

  return (
    <div className="stack">
      <div className="card small row" style={{ justifyContent: "space-between" }}>
        <span>
          <b>수정 횟수</b> 사용 {count.used}회 / 포함 {typeof count.included === "number" ? `${count.included}회` : `${count.included} (${settings.revision.includedCountRange} 중 결정 필요)`}
          {count.unknown > 0 && <> · 포함 여부 미정 {count.unknown}건</>}
          {count.newDrafts > 0 && <> · 새 시안 {count.newDrafts}건 (수정 횟수 아님, 별도 협의)</>}
        </span>
        {count.over && <span className="warn">포함 횟수를 넘었습니다. 추가 비용 협의가 필요할 수 있습니다</span>}
        <span className="muted">기록: revisions.md</span>
      </div>

      {before && lastRev && (
        <div className="card stack small">
          <b className="warn">수정 중 ({lastRev.source} 요청, {lastRev.type})</b>
          <div>{lastRev.detail}</div>
          <div className="muted">
            {status === "gate1_approved" ? "이미지 단계부터" : "합성 단계에서"} 고친 뒤 PNG 저장 → 검수 → 게이트 2를 거치면 {doc.proofs.length + 1}차 시안을 보낼 수 있습니다.
          </div>
        </div>
      )}

      {/* 1. 광고주에게 보내기 */}
      {status === "gate2_approved" && (
        <div className="card stack small">
          <b>광고주 시안 확인 {latest ? `(${latest.round}차)` : ""}</b>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            <li>
              <button disabled={!!busy} onClick={() => run("proof", async () => {
                const f = await dsvc.makeProof(caseId, name);
                downloadJson(`시안확인_${company}_${f.round}차.json`, f);
              })}>
                {latest && !latestAnswer ? "시안 확인 파일 다시 받기" : "시안 확인 파일 내려받기"}
              </button>{" "}
              <span className="muted">A/B 시안 이미지와 문구만 들어 있습니다 (담당자 이름·연락처 없음).</span>
            </li>
            <li>
              파일과 함께 이 주소를 광고주에게 보냅니다: <code>{proofLink}</code>{" "}
              <button className="small" onClick={() => navigator.clipboard?.writeText(proofLink)}>주소 복사</button>
              <div className="muted">광고주는 휴대폰에서 주소를 열고 파일을 골라 확정하거나 수정 요청을 한 뒤, 답변 파일을 돌려줍니다. 로그인은 필요 없습니다.</div>
            </li>
            <li>
              <button className="primary" disabled={!!busy || !latest} onClick={() => run("answer", async () => dsvc.importAnswer(caseId, await pickJsonFile(), name))}>
                광고주 답변 파일 가져오기
              </button>{" "}
              {!latest && <span className="muted">먼저 시안 확인 파일을 만드세요.</span>}
            </li>
          </ol>
          <InternalRevision disabled={!!busy} onSave={(kinds, detail) => run("rev", () => dsvc.requestRevision(caseId, { source: "내부", kinds, detail }, name))} />
        </div>
      )}

      {/* 2. 고른 시안 */}
      {picked && (
        <div className="card stack small">
          <b>{doc.delivered ? "납품한 시안" : "광고주가 고른 시안"}: {picked}</b>
          <div className="row" style={{ alignItems: "flex-start" }}>
            {Object.entries(thumbs).map(([s, u]) => (
              <img key={s} src={u} alt={`${picked} ${s}`} style={{ width: s === "320x100" ? 220 : 150, border: "1px solid var(--line)" }} />
            ))}
          </div>
          {doc.answers.at(-1)?.comment && <div>광고주 의견: {doc.answers.at(-1)!.comment}</div>}
        </div>
      )}

      {/* 3. 완성본 심의 */}
      {ready.reviewRequired && status === "client_selected" && (
        <FinalReviewForm current={doc.finalReview} disabled={!!busy} onSave={(r) => run("review", () => dsvc.recordFinalReview(caseId, r, name))} />
      )}
      {ready.reviewRequired && doc.finalReview && status !== "client_selected" && (
        <div className="small muted">완성본 심의: {doc.finalReview.result} ({doc.finalReview.date}, {doc.finalReview.by})</div>
      )}

      {/* 3-1. 변형: 사이즈 추가 */}
      {status === "client_selected" && doc.selectedVariant && (
        <VariantSizes caseId={caseId} name={name} doc={doc} maxKB={media.maxKB ?? (typeof settings.qa.maxFileKB === "number" ? settings.qa.maxFileKB : null)} suggestedSize={media.size} onChanged={() => { reload().catch(() => {}); onChanged(); }} />
      )}

      {/* 4. 납품 */}
      {(status === "client_selected" || status === "delivered") && (
        <div className="card stack small">
          <b>납품</b>
          {status === "delivered" && doc.delivered ? (
            <div className="okc">✓ 납품 완료 ({new Date(doc.delivered.at).toLocaleString("ko-KR")}, {doc.delivered.by})</div>
          ) : (
            ready.blockers.map((b) => <div key={b} className="warn">✗ {b}</div>)
          )}
          <div className="row">
            <button
              className="primary"
              disabled={!!busy || (status !== "delivered" && !ready.ok)}
              onClick={() => run("zip", async () => {
                const z = await dsvc.exportZip(caseId, name);
                downloadBytes(z.name, z.bytes, "application/zip");
              })}
            >
              {busy === "zip" ? "묶는 중…" : status === "delivered" ? "납품 ZIP 다시 받기" : "납품 ZIP 내려받기 (납품 완료)"}
            </button>
            <span className="muted">고른 시안의 사이즈별 PNG, 합성 명세, 검수 보고서, 승인·수정 기록이 들어갑니다.</span>
          </div>
          {status === "client_selected" && (
            <InternalRevision label="납품 전에 고칠 것이 있으면" disabled={!!busy} onSave={(kinds, detail) => run("rev", () => dsvc.requestRevision(caseId, { source: "내부", kinds, detail }, name))} />
          )}
        </div>
      )}

      {err && <p className="err" style={{ margin: 0 }}>⚠ {err}</p>}

      {(doc.revisions.length > 0 || doc.proofs.length > 0) && (
        <details className="card small">
          <summary>주고받은 기록 (시안 {doc.proofs.length}회, 수정 요청 {doc.revisions.length}건)</summary>
          <ul style={{ paddingLeft: 18 }}>
            {doc.proofs.map((p) => {
              const a = doc.answers.find((x) => x.proofId === p.id);
              return (
                <li key={p.id}>
                  {p.round}차 발송 {new Date(p.createdAt).toLocaleString("ko-KR")} ({p.createdBy}) →{" "}
                  {a ? (a.decision === "confirm" ? `시안 ${a.variant} 확정` : `수정 요청: ${a.requests.map((r) => `${r.kind}(${r.detail})`).join(", ")}`) : "답변 기다리는 중"}
                </li>
              );
            })}
            {doc.revisions.map((r) => (
              <li key={r.at}>
                {new Date(r.at).toLocaleString("ko-KR")} · {r.source} · {r.type} · {r.kinds.join(", ")} · {r.detail} · {r.type === "새 시안" ? "새 시안" : r.counted === null ? "포함 여부 미정" : r.counted ? "수정 횟수 포함" : "수정 횟수 제외"}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function KindPicker({ kinds, onChange }: { kinds: RevisionKind[]; onChange: (k: RevisionKind[]) => void }) {
  return (
    <div className="row">
      {REVISION_KINDS.map((k) => (
        <label key={k} className="row">
          <input type="checkbox" checked={kinds.includes(k)} onChange={(e) => onChange(e.target.checked ? [...kinds, k] : kinds.filter((x) => x !== k))} /> {k}
        </label>
      ))}
    </div>
  );
}

/** 광고주 요청 없이 우리가 고칠 때 (수정 횟수에 넣지 않음) */
function InternalRevision({ label = "광고주에게 보내기 전에 고칠 것이 있으면", disabled, onSave }: { label?: string; disabled: boolean; onSave: (kinds: RevisionKind[], detail: string) => void }) {
  const [open, setOpen] = useState(false);
  const [kinds, setKinds] = useState<RevisionKind[]>([]);
  const [detail, setDetail] = useState("");
  if (!open) return <div className="muted">{label} <button className="small" onClick={() => setOpen(true)}>내부 수정 시작</button></div>;
  return (
    <div className="stack" style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
      <b>내부 수정 (수정 횟수에 넣지 않음)</b>
      <KindPicker kinds={kinds} onChange={setKinds} />
      <input type="text" placeholder="무엇을 고치는지" value={detail} onChange={(e) => setDetail(e.target.value)} />
      <div className="muted">글자·색·위치·크기는 합성 단계로, 이미지 교체·콘셉트 변경은 이미지 단계로 돌아갑니다. 고친 뒤 다시 검수와 게이트 2를 거칩니다.</div>
      <div className="row">
        <button className="primary" disabled={disabled || !kinds.length} onClick={() => onSave(kinds, detail)}>수정 시작</button>
        <button onClick={() => setOpen(false)}>닫기</button>
      </div>
    </div>
  );
}

function FinalReviewForm({ current, disabled, onSave }: { current: FinalReview | null; disabled: boolean; onSave: (r: { result: FinalReview["result"]; date: string; memo: string; kinds?: RevisionKind[] }) => void }) {
  const [result, setResult] = useState<FinalReview["result"]>(current?.result ?? "통과");
  const [date, setDate] = useState(current?.date ?? "");
  const [memo, setMemo] = useState(current?.memo ?? "");
  const [kinds, setKinds] = useState<RevisionKind[]>(["글자"]);
  return (
    <div className="card stack small">
      <b className="warn">완성본 심의 (심의 업종)</b>
      <span className="muted">광고주가 고른 시안의 완성본(카피와 이미지 전체)을 심의 기관에 내고, 결과를 여기에 기록합니다. 통과 기록이 있어야 납품할 수 있습니다.</span>
      {current && <div>기록됨: {current.result} ({current.date}, {current.by})</div>}
      <div className="row">
        <label className="row"><input type="radio" checked={result === "통과"} onChange={() => setResult("통과")} /> 통과</label>
        <label className="row"><input type="radio" checked={result === "수정 필요"} onChange={() => setResult("수정 필요")} /> 수정 필요</label>
        <label className="row">심의 날짜 <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      </div>
      <input type="text" placeholder="메모 (심의 번호, 지적 사항 등)" value={memo} onChange={(e) => setMemo(e.target.value)} />
      {result === "수정 필요" && (
        <>
          <KindPicker kinds={kinds} onChange={setKinds} />
          <span className="muted">
            기록하면 {revisionType(kinds) === "새 시안" ? "새 시안으로" : "수정으로"} 분류되어 앞 단계로 돌아갑니다. 심의 때문에 고치는 것을 수정 횟수에 넣을지는 미정입니다.
          </span>
        </>
      )}
      <button className="primary" disabled={disabled || !date || (result === "수정 필요" && !kinds.length)} onClick={() => onSave({ result, date, memo, kinds: result === "수정 필요" ? kinds : undefined })}>
        심의 결과 기록
      </button>
    </div>
  );
}

