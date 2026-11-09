"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { CaseState } from "@/lib/state";
import type { Tag } from "@/core/tags";
import { renderTag } from "@/core/tags";
import type { BriefRow } from "@/core/brief";
import type { Idea } from "@/core/ideas";

const STAGES = [
  { key: "intake", label: "질문 수집" },
  { key: "brief", label: "브리프" },
  { key: "ideas", label: "아이디어" },
  { key: "gate1", label: "게이트 1", gate: true },
  { key: "images", label: "이미지" },
  { key: "compose", label: "합성" },
  { key: "qa", label: "검수" },
  { key: "gate2", label: "게이트 2", gate: true },
  { key: "export", label: "납품" },
];

function stageIndex(s: CaseState): number {
  if (s.meta.status === "gate1_approved") return 4;
  if (s.ideas) return 3;
  if (s.brief) return 2;
  return 1;
}

function TagChips({ tags }: { tags: Tag[] }) {
  return (
    <>
      {tags.map((t, i) => (
        <span key={i} className={`tag ${t.kind}`}>{renderTag(t).slice(1, -1)}</span>
      ))}
    </>
  );
}

function getName(): string {
  try { return localStorage.getItem("ad-agent:name") ?? ""; } catch { return ""; }
}
function saveName(n: string) {
  try { localStorage.setItem("ad-agent:name", n); } catch { /* 저장 안 돼도 동작 */ }
}

export default function CasePage({ params }: { params: Promise<{ id: string }> }) {
  // 라우트 파라미터는 인코딩된 채로 온다 (한글 케이스 id). 한 번만 풀어서 쓴다.
  const id = decodeURIComponent(use(params).id);
  const [s, setS] = useState<CaseState | null>(null);
  const [busy, setBusy] = useState<string>("");
  const [err, setErr] = useState("");
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string>("");
  const [note, setNote] = useState("");

  useEffect(() => setName(getName()), []);

  const call = useCallback(async (label: string, url: string, body?: unknown) => {
    setBusy(label);
    setErr("");
    try {
      const res = await fetch(url, body === undefined && label === "load" ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "요청 실패");
      setS(j as CaseState);
      if ((j as CaseState).ideas?.selectedId) setPicked((j as CaseState).ideas!.selectedId!);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "요청 실패");
    } finally {
      setBusy("");
    }
  }, []);

  const base = `/api/cases/${encodeURIComponent(id)}`;
  useEffect(() => { call("load", base); }, [call, base]);

  if (!s) return <main className="wrap">{err ? <p className="err">{err}</p> : <p className="muted">불러오는 중…</p>}</main>;

  const locked = s.meta.status === "gate1_approved";
  const now = stageIndex(s);
  const brief = s.brief;
  const ideas = s.ideas;
  const decide = (rowId: string, value: string) => {
    if (!name.trim()) { setErr("위쪽 '내 이름'을 먼저 적어 주세요 (확정 기록에 남습니다)"); return; }
    saveName(name);
    call(`decide:${rowId}`, `${base}/decisions`, { rowId, value, by: name });
  };

  return (
    <main className="wrap">
      <p className="small"><Link href="/console">← 케이스 목록</Link></p>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h1>{s.meta.company}</h1>
          <span className="small muted">{s.meta.id} · 모델 {s.settings.model} · 합성 백엔드 {s.meta.backend}</span>
        </div>
        <label className="small row">내 이름 <input type="text" style={{ width: 160 }} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => saveName(name)} /></label>
      </div>

      <div className="console">
        <aside>
          <ol className="steps">
            {STAGES.map((st, i) => (
              <li key={st.key} className={[i < now ? "done" : "", i === now ? "now" : "", st.gate ? "gate" : ""].join(" ")}>
                {i < now ? "✓ " : ""}{st.label}
              </li>
            ))}
          </ol>
          {s.meta.extraSteps.length > 0 && (
            <div className="card small" style={{ marginTop: 12 }}>
              <strong className="warn">심의 업종 추가 단계</strong>
              <ul style={{ paddingLeft: 18, margin: "6px 0 0" }}>{s.meta.extraSteps.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
          )}
        </aside>

        <section>
          {err && <p className="err card">{err}</p>}

          <div className="card small">
            <strong>1부 질문지</strong> · "모르겠음": {s.unknowns.length ? s.unknowns.map((n) => `${n}번`).join(", ") : "없음"}
            {" "}· 동의: 개인정보 ✓ · 포트폴리오 {s.intake.consent.portfolio ? "✓" : "✗"}
          </div>

          <h2>브리프 (2부)</h2>
          <div className="row">
            <button className="primary" disabled={locked || !!busy} onClick={() => call("brief", `${base}/brief`)}>
              {busy === "brief" ? "브리프 작성 중… (1~2분)" : brief ? "브리프 다시 만들기" : "브리프 만들기"}
            </button>
            {brief && <span className="small muted">생성 {new Date(brief.generatedAt).toLocaleString("ko-KR")} · 목적 {brief.objectiveCategory}{brief.objectiveEstimated ? " (추정)" : ""} · 심의 {brief.reviewStatus} · 근거 {brief.evidenceStatus}</span>}
          </div>

          {brief && (
            <>
              <div className="card table-scroll" style={{ marginTop: 12 }}>
                <table className="brief">
                  <thead><tr><th style={{ width: 90 }}>영역</th><th style={{ width: 130 }}>항목</th><th>내용</th><th style={{ width: 190 }}>태그</th></tr></thead>
                  <tbody>
                    {brief.rows.map((r) => <BriefTr key={r.id} r={r} decided={brief.decisions[r.id]?.value} />)}
                  </tbody>
                </table>
              </div>

              <h2>사람이 확정할 항목 <span className="small muted">({s.openCount}개 남음 / 전체 {brief.checklist.length}개)</span></h2>
              <div className="stack">
                {brief.checklist.map((c) => {
                  const r = brief.rows.find((x) => x.id === c.id)!;
                  return (
                    <CheckItem key={c.id} row={r} reasons={c.reasons} decided={brief.decisions[c.id]} locked={locked} busy={busy === `decide:${c.id}`} onDecide={(v) => decide(c.id, v)} />
                  );
                })}
              </div>
            </>
          )}

          <h2>아이디어 3안</h2>
          <div className="row">
            <button className="primary" disabled={locked || !brief || !!busy} onClick={() => call("ideas", `${base}/ideas`)}>
              {busy === "ideas" ? "아이디어 만드는 중… (1~2분)" : ideas ? "아이디어 다시 만들기" : "아이디어 만들기"}
            </button>
            <span className="small muted">확정한 브리프 값(핵심 메시지, CTA 등)이 있으면 반영됩니다.</span>
          </div>
          {ideas && (
            <>
              {ideas.issues.filter((i) => i.where === "ideas").map((i, k) => <p key={k} className={`small ${i.severity === "error" ? "err" : "warn"}`}>⚠ {i.message}</p>)}
              <div className="ideas" style={{ marginTop: 12 }}>
                {ideas.ideas.map((x) => (
                  <IdeaCard key={x.id} x={x} on={picked === x.id} issues={ideas.issues.filter((i) => i.where === x.id)} onPick={() => !locked && setPicked(x.id)} />
                ))}
              </div>
            </>
          )}

          <h2>승인 기록</h2>
          <pre className="card small" style={{ whiteSpace: "pre-wrap" }}>{s.approvals}</pre>
        </section>
      </div>

      <div className="bottombar">
        <div className="inner">
          <div className="small">
            {locked ? (
              <strong className="okc">게이트 1 승인 완료 — 다음 단계(이미지)는 3단계에서 구현</strong>
            ) : (
              <>
                남은 확정 항목 <strong>{s.openCount ?? "-"}</strong>개 · 선택한 아이디어 <strong>{picked ? picked.replace("idea-", "") + "안" : "없음"}</strong>
                {s.readiness.blockers.length > 0 && <div className="muted">{s.readiness.blockers.join(" · ")}</div>}
              </>
            )}
          </div>
          {!locked && (
            <div className="row">
              <input type="text" placeholder="승인 메모 (선택)" style={{ width: 220 }} value={note} onChange={(e) => setNote(e.target.value)} />
              <button
                className="primary"
                disabled={!!busy || !picked || !s.readiness.ok || !name.trim()}
                onClick={() => { saveName(name); call("gate1", `${base}/gate1`, { ideaId: picked, approver: name, note }); }}
                title={!name.trim() ? "내 이름을 적어 주세요" : ""}
              >
                게이트 1 승인
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function BriefTr({ r, decided }: { r: BriefRow; decided?: string }) {
  return (
    <tr>
      <td className="muted">{r.area}</td>
      <td>{r.label}</td>
      <td>
        {decided && <div><strong>확정:</strong> {decided}</div>}
        <div className={decided ? "small muted" : ""}>
          {r.content.split("<br>").map((l, i) => <div key={i}>{l}</div>)}
          {r.candidates && r.candidates.length > 0 && (
            <ol style={{ margin: "4px 0 0", paddingLeft: 18 }}>{r.candidates.map((c) => <li key={c}>{c}</li>)}</ol>
          )}
        </div>
      </td>
      <td><TagChips tags={decided && !r.tags.some((t) => t.kind === "user") ? [...r.tags, { kind: "user" }] : r.tags} /></td>
    </tr>
  );
}

function CheckItem({ row, reasons, decided, locked, busy, onDecide }: {
  row: BriefRow; reasons: string[]; decided?: { value: string; decidedBy: string; decidedAt: string }; locked: boolean; busy: boolean; onDecide: (v: string) => void;
}) {
  const [custom, setCustom] = useState("");
  const options = row.candidates?.length ? row.candidates : [row.content];
  return (
    <div className={`card check ${decided ? "closed" : "open"}`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>{row.label}</strong>
        <span className="small">{reasons.map((x) => <span key={x} className={`tag ${x.startsWith("검증 오류") ? "estimate" : x === "사용자 결정" ? "user" : x === "추정" ? "estimate" : "ai"}`}>{x}</span>)}</span>
      </div>
      {decided ? (
        <div className="row small" style={{ marginTop: 6 }}>
          <span>✓ 확정: <strong>{decided.value}</strong> <span className="muted">({decided.decidedBy})</span></span>
          {!locked && <button disabled={busy} onClick={() => onDecide("")}>확정 취소</button>}
        </div>
      ) : (
        <div className="stack" style={{ marginTop: 8 }}>
          {options.map((o) => (
            <button key={o} className="choice small" disabled={locked || busy} onClick={() => onDecide(o)}>
              {row.candidates?.length ? "이 후보로 확정: " : "이 내용 그대로 확정: "}{o}
            </button>
          ))}
          <div className="row">
            <input type="text" placeholder="직접 고쳐서 확정" value={custom} onChange={(e) => setCustom(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
            <button disabled={locked || busy || !custom.trim()} onClick={() => onDecide(custom)}>확정</button>
          </div>
        </div>
      )}
    </div>
  );
}

function IdeaCard({ x, on, issues, onPick }: { x: Idea; on: boolean; issues: { severity: string; message: string }[]; onPick: () => void }) {
  return (
    <div className={`card idea stack small ${on ? "on" : ""}`} onClick={onPick} style={{ cursor: "pointer" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="muted">{x.id.replace("idea-", "")}안 · {x.direction}</span>
        <span><TagChips tags={x.tags} /></span>
      </div>
      <h3>{x.title}</h3>
      <div>{x.concept}</div>
      <div><strong>헤드라인</strong><ul style={{ margin: 0, paddingLeft: 18 }}>{x.headlines.map((h) => <li key={h}>{h}</li>)}</ul></div>
      <div><strong>서브</strong> {x.subCopy}</div>
      <div><strong>버튼</strong> {x.cta}</div>
      <div><strong>비주얼</strong> {x.visual.scene} · {x.visual.composition} · 빈 공간 {x.visual.copySpace} · {x.visual.mood}</div>
      <div><strong>근거</strong> <span className={x.evidenceStatus === "근거 없음" ? "warn" : ""}>{x.evidenceStatus}</span>{x.evidenceSource ? ` (${x.evidenceSource})` : ""}</div>
      {x.requestToClient && <div className="warn">보완 요청: {x.requestToClient}</div>}
      {x.productPhotoNote && <div className="warn">{x.productPhotoNote}</div>}
      {x.riskNotes && <div className="warn">위험 표현: {x.riskNotes}</div>}
      {issues.map((i, k) => <div key={k} className={i.severity === "error" ? "err" : "warn"}>⚠ {i.message}</div>)}
      <button className={on ? "primary" : ""}>{on ? "선택됨" : "이 안 고르기"}</button>
    </div>
  );
}
