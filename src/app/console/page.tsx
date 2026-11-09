import Link from "next/link";
import { listCases } from "@/core/case";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = {
  intake_done: "질문 수집 완료",
  brief_draft: "브리프 초안",
  ideas_draft: "아이디어 초안",
  gate1_approved: "게이트 1 승인",
};

export default function ConsoleList() {
  const cases = listCases();
  return (
    <main className="wrap stack">
      <h1>케이스</h1>
      <p className="small"><Link href="/">← 처음</Link> · <Link href="/intake">새 질문지</Link></p>
      {cases.length === 0 && <p className="muted">아직 케이스가 없습니다.</p>}
      {cases.map((c) => (
        <Link key={c.id} href={`/console/${encodeURIComponent(c.id)}`} style={{ textDecoration: "none", color: "inherit" }}>
          <div className="card row" style={{ justifyContent: "space-between" }}>
            <div>
              <strong>{c.company}</strong> <span className="small muted">{c.id}</span>
            </div>
            <span className="small">{STATUS[c.status] ?? c.status}</span>
          </div>
        </Link>
      ))}
    </main>
  );
}
