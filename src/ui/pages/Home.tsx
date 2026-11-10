import { href } from "../app";

export function Home() {
  const clientLink = `${location.origin}${location.pathname}#/intake?mode=client`;
  return (
    <main className="narrow stack">
      <h1>광고 시안 에이전트</h1>
      <p className="muted">AI가 초안을 만들고, 사람이 고르고 마무리합니다. (MVP 1단계: 질문지 → 브리프 → 아이디어 3안 → 게이트 1)</p>
      <div className="card stack small">
        <strong>이 앱이 데이터를 다루는 방식</strong>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>질문지 답, 브리프, 승인 기록은 <b>이 PC에만</b> 저장됩니다 (브라우저 저장소 또는 고른 폴더).</li>
          <li>API 키와 연결 정보도 <b>이 브라우저에만</b> 저장됩니다. 원하면 비밀번호로 잠글 수 있습니다.</li>
          <li>AI 생성을 위해 질문지 답(담당자 이름·연락처 제외)이 선택한 LLM(Anthropic API 또는 이 PC의 Claude CLI)으로 전송됩니다.</li>
        </ul>
      </div>
      <div className="card stack">
        <h3>1. 연결 설정</h3>
        <p className="small muted">본인의 Anthropic API 키를 넣거나, Claude CLI를 쓰려면 브리지를 실행해 연결합니다.</p>
        <a href={href("settings")}><button>설정 열기</button></a>
      </div>
      <div className="card stack">
        <h3>2. 질문지</h3>
        <p className="small muted">담당자가 광고주와 함께 입력하거나, 광고주에게 아래 링크를 보내 답변 파일을 받습니다.</p>
        <a href={href("intake")}><button className="primary">질문지 시작</button></a>
        <div className="small">광고주용 링크: <code style={{ wordBreak: "break-all" }}>{clientLink}</code></div>
      </div>
      <div className="card stack">
        <h3>3. 케이스</h3>
        <p className="small muted">브리프·아이디어 생성, 확정 항목 처리, 게이트 1 승인. 광고주 답변 파일 가져오기.</p>
        <a href={href("cases")}><button>케이스 열기</button></a>
      </div>
    </main>
  );
}
