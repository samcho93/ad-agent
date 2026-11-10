import { useCallback, useEffect, useMemo, useState } from "react";
import { QaService } from "@/core/qaService";
import { reached, type CaseStatus } from "@/core/caseService";
import { type QaCheck, type QaDoc, type Gate2Readiness, humanChecklist } from "@/core/qa";
import { imageQaWith } from "@/llm/qaPipeline";
import { PROVIDER_LABEL } from "@/llm/select";
import { errMsg, useApp } from "../app";

const LLM_LABEL: Record<QaDoc["llm"]["status"], string> = {
  done: "완료",
  unsupported: "이 연결 방식은 이미지 검수를 지원하지 않습니다. 사람이 확인하세요",
  failed: "실패했습니다. 사람이 확인하세요",
  skipped: "하지 않았습니다 (규칙만). 사람이 확인하세요",
};

/** 검수(ad-qa)와 게이트 2 (디자이너 최종 검수) */
export function QaSection({ caseId, name, status, onChanged }: { caseId: string; name: string; status: CaseStatus; onChanged: () => void }) {
  const { svc, generator, settings } = useApp();
  const qaSvc = useMemo(() => new QaService(svc), [svc]);
  const [qa, setQa] = useState<QaDoc | null>(null);
  const [ready, setReady] = useState<Gate2Readiness>({ ok: false, blockers: [] });
  const [fresh, setFresh] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const passed = reached(status, "gate2_approved");

  const reload = useCallback(async () => {
    const q = await qaSvc.getDoc(caseId);
    setQa(q);
    setFresh(await qaSvc.isFresh(caseId, q));
    setReady(await qaSvc.readiness(caseId));
  }, [qaSvc, caseId]);
  useEffect(() => {
    reload().catch((e) => setErr(errMsg(e)));
  }, [reload, status]);

  const run = async (label: string, work: () => Promise<unknown>) => {
    if (!name.trim()) return setErr("위쪽 '내 이름'을 먼저 적어 주세요 (검수 기록에 남습니다)");
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

  const runQa = (withLlm: boolean) =>
    run(withLlm ? "qa-llm" : "qa-rules", () => qaSvc.run(caseId, name, withLlm ? imageQaWith(generator(), (e) => svc.log(caseId, e)) : undefined));

  const errors = qa?.checks.filter((c) => c.severity === "error") ?? [];
  const warnings = qa?.checks.filter((c) => c.severity === "warning") ?? [];
  const infos = qa?.checks.filter((c) => c.severity === "info") ?? [];
  const human = qa ? humanChecklist(qa) : [];

  return (
    <div className="stack">
      {!passed && (
        <div className="card stack small">
          <div className="row">
            <button className="primary" disabled={!!busy} onClick={() => runQa(true)}>
              {busy === "qa-llm" ? "검수 중… (이미지를 LLM에 보냄)" : qa ? "다시 검수 (규칙 + 이미지)" : "검수 실행 (규칙 + 이미지)"}
            </button>
            <button disabled={!!busy} onClick={() => runQa(false)}>{busy === "qa-rules" ? "검수 중…" : "규칙만 검사 (비용 없음)"}</button>
          </div>
          <span className="muted">
            이미지 검수는 {PROVIDER_LABEL[settings.llm.provider]}에 시안 PNG 6장(누끼를 썼으면 원본 제품 사진 포함)을 보내 판정합니다. 실행할 때마다 LLM 비용이 듭니다.
            검수는 결과 PNG만 보고 하며, 만든 과정과 분리되어 있습니다.
          </span>
          {qa && !fresh && <div className="warn">⚠ 검수 뒤에 합성이 바뀌었습니다. 다시 검수하세요.</div>}
          {err && <p className="err" style={{ margin: 0 }}>⚠ {err}</p>}
        </div>
      )}

      {qa && (
        <div className="card stack small">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <b>자동 검수 결과</b>
            <span className="muted">{new Date(qa.ranAt).toLocaleString("ko-KR")} · {qa.ranBy}{qa.review ? " · 심의 업종" : ""}</span>
          </div>
          <div className={qa.llm.status === "done" ? "okc" : "warn"}>
            이미지 검수(LLM): {LLM_LABEL[qa.llm.status]}{qa.llm.model ? ` · ${qa.llm.model}` : ""}
            {qa.llm.status !== "done" && qa.llm.note && <div className="muted">{qa.llm.note}</div>}
          </div>
          {qa.llm.overall && <div><span className="tag ai">AI 초안</span> 총평: {qa.llm.overall}</div>}
          {errors.length === 0 && warnings.length === 0 && <div className="okc">✓ 오류·경고 없음</div>}
          {errors.map((c) => (
            <ErrorRow key={c.id} c={c} override={qa.overrides[c.id]} disabled={passed || !!busy} onSave={(reason) => run(`ov:${c.id}`, () => qaSvc.setOverride(caseId, c.id, reason, name))} />
          ))}
          {warnings.map((c) => (
            <div key={c.id} className="warn">⚠ <Src c={c} /> {c.where}: {c.message}</div>
          ))}
          {infos.length > 0 && (
            <details>
              <summary className="muted">확인한 항목 {infos.length}개 (규격·용량 등)</summary>
              {infos.map((c) => <div key={c.id} className="muted">· {c.where}: {c.message}</div>)}
            </details>
          )}
          <span className="muted">검수 보고서: qa_report.md · 결과: qa.json</span>
        </div>
      )}

      {qa && (
        <div className="card stack small">
          <b>게이트 2 — 디자이너 최종 검수</b>
          {human.map((h) => (
            <label key={h} className="row" style={{ alignItems: "flex-start" }}>
              <input
                type="checkbox"
                checked={!!qa.human[h]}
                disabled={passed || !!busy || !fresh}
                onChange={(e) => run(`h:${h}`, () => qaSvc.setHuman(caseId, h, e.target.checked, name))}
              />
              <span>
                {h}
                {qa.human[h] && <span className="muted"> ({qa.human[h].by})</span>}
              </span>
            </label>
          ))}
          {passed ? (
            <div className="okc"><strong>✓ 게이트 2 통과</strong> — 아래 납품 단계에서 광고주에게 시안을 보내세요.</div>
          ) : (
            <>
              {ready.blockers.map((b) => <div key={b} className="warn">✗ {b}</div>)}
              <div className="row">
                <input type="text" placeholder="승인 메모 (선택)" style={{ flex: 1, minWidth: 180 }} value={note} onChange={(e) => setNote(e.target.value)} />
                <button className="primary" disabled={!!busy || !ready.ok || !name.trim()} onClick={() => run("gate2", () => qaSvc.approveGate2(caseId, name, note))}>
                  게이트 2 승인
                </button>
              </div>
              {!name.trim() && <div className="warn">✗ 위쪽 '내 이름'(승인자)을 적어 주세요</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Src({ c }: { c: QaCheck }) {
  return <span className={`tag ${c.source === "llm" ? "ai" : "intake"}`}>{c.source === "llm" ? "이미지(LLM)" : "규칙"}</span>;
}

/** 오류 한 줄: 고치거나, 사유를 적고 넘긴다 */
function ErrorRow({ c, override, disabled, onSave }: { c: QaCheck; override?: { reason: string; by: string }; disabled: boolean; onSave: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className={override ? "muted" : "err"}>
        {override ? "↷" : "✗"} <Src c={c} /> {c.where}: {c.message}
      </div>
      {override ? (
        <div className="row" style={{ paddingLeft: 18 }}>
          <span className="muted">넘김 사유: {override.reason} ({override.by})</span>
          {!disabled && <button className="small" onClick={() => onSave("")}>넘김 취소</button>}
        </div>
      ) : (
        !disabled && (
          <div className="row" style={{ paddingLeft: 18 }}>
            <input type="text" placeholder="고치지 않고 넘기는 사유 (예: 원본 포장 글자임)" style={{ flex: 1, minWidth: 200 }} value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="small" disabled={!reason.trim()} onClick={() => onSave(reason)}>사유 적고 넘기기</button>
          </div>
        )
      )}
    </div>
  );
}
