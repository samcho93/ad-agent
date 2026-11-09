import Link from "next/link";

export default function Home() {
  return (
    <main className="narrow stack">
      <h1>광고 시안 에이전트</h1>
      <p className="muted">AI가 초안을 만들고, 사람이 고르고 마무리합니다. (MVP 1단계)</p>
      <div className="card stack">
        <h3>광고주</h3>
        <p className="small muted">한 화면에 한 질문씩, 12개 질문에 답합니다. 모르면 "모르겠음"을 고르세요.</p>
        <Link href="/intake"><button className="primary">질문지 시작</button></Link>
      </div>
      <div className="card stack">
        <h3>내부 콘솔 (AE·디자이너)</h3>
        <p className="small muted">브리프·아이디어 생성, 확정 항목 처리, 게이트 1 승인.</p>
        <Link href="/console"><button>콘솔 열기</button></Link>
      </div>
    </main>
  );
}
