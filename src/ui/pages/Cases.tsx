import { useEffect, useState } from "react";
import type { CaseMeta } from "@/core/caseService";
import { errMsg, go, href, pickJsonFile, useApp } from "../app";

const STATUS: Record<string, string> = {
  intake_done: "질문 수집 완료",
  brief_draft: "브리프 초안",
  ideas_draft: "아이디어 초안",
  gate1_approved: "게이트 1 승인 · 이미지 단계",
  images_selected: "이미지 확정 · 합성 단계",
  compose_done: "합성 완료 · 검수 단계",
  qa_done: "검수 완료 · 게이트 2",
  gate2_approved: "게이트 2 통과 · 광고주 확인",
  client_selected: "광고주 확정 · 납품 전",
  delivered: "납품 완료",
};

export function Cases() {
  const { svc, store } = useApp();
  const [cases, setCases] = useState<CaseMeta[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    svc.listCases().then(setCases, (e) => setErr(errMsg(e)));
  }, [svc]);

  async function importAnswer() {
    setErr("");
    try {
      const meta = await svc.createCase(await pickJsonFile());
      go("cases", meta.id);
    } catch (e) {
      setErr(errMsg(e));
    }
  }
  async function importCase() {
    setErr("");
    try {
      const meta = await svc.importCase(await pickJsonFile(80));
      if (meta.skipped.length) alert(`케이스를 가져왔습니다. 케이스 파일이 아닌 ${meta.skipped.length}개는 건너뛰었습니다:\n${meta.skipped.slice(0, 10).join("\n")}`);
      go("cases", meta.id);
    } catch (e) {
      setErr(errMsg(e));
    }
  }

  return (
    <main className="wrap stack">
      <h1>케이스</h1>
      <p className="small muted">저장 위치: {store.label}</p>
      <div className="row">
        <a href={href("intake")}><button className="primary">새 질문지</button></a>
        <button onClick={importAnswer}>광고주 답변 파일 가져오기</button>
        <button onClick={importCase}>케이스 파일 가져오기</button>
      </div>
      {err && <p className="err card">{err}</p>}
      {cases === null && !err && <p className="muted">불러오는 중…</p>}
      {cases?.length === 0 && <p className="muted">아직 케이스가 없습니다.</p>}
      {cases?.map((c) => (
        <a key={c.id} href={href("cases", c.id)} style={{ textDecoration: "none", color: "inherit" }}>
          <div className="card row" style={{ justifyContent: "space-between" }}>
            <div>
              <strong>{c.company}</strong> <span className="small muted">{c.id}</span>
            </div>
            <span className="small">{STATUS[c.status] ?? c.status}</span>
          </div>
        </a>
      ))}
    </main>
  );
}
