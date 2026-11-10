import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./ui/styles.css";
import { AppProvider, href, useApp, useRoute } from "./ui/app";
import { Home } from "./ui/pages/Home";
import IntakePage from "./ui/pages/Intake";
import { Cases } from "./ui/pages/Cases";
import CasePage from "./ui/pages/CaseDetail";
import { SettingsPage } from "./ui/pages/Settings";
import { ProofPage } from "./ui/pages/ProofPage";
import { PROVIDER_LABEL } from "./llm/select";
import { currentModel } from "./core/settings";

function Nav({ route }: { route: string[] }) {
  const { settings, store } = useApp();
  const on = (k: string) => (route[0] ?? "") === k ? "on" : "";
  return (
    <nav className="topnav">
      <a href={href()} className={on("")}><strong>광고 시안 에이전트</strong></a>
      <a href={href("intake")} className={on("intake")}>질문지</a>
      <a href={href("cases")} className={on("cases")}>케이스</a>
      <a href={href("settings")} className={on("settings")}>설정</a>
      <span className="spacer" />
      <span className="small muted">{PROVIDER_LABEL[settings.llm.provider]} · {store.label}</span>
    </nav>
  );
}

function Banners() {
  const { secretsStatus, folderNeedsPermission, grantFolder, settings } = useApp();
  return (
    <>
      {secretsStatus === "locked" && (
        <div className="banner warn">저장된 키가 잠겨 있습니다. <a href={href("settings")}>설정에서 비밀번호로 열기</a></div>
      )}
      {secretsStatus === "empty" && settings.llm.provider !== "fake" && (
        <div className="banner warn">LLM 연결이 없습니다. <a href={href("settings")}>설정에서 API 키 또는 Claude CLI 브리지를 연결</a>하세요.</div>
      )}
      {settings.llm.provider !== "fake" && !currentModel(settings) && (
        <div className="banner warn">{PROVIDER_LABEL[settings.llm.provider]}의 모델을 아직 고르지 않았습니다. <a href={href("settings")}>설정에서 연결 확인 후 모델 선택</a></div>
      )}
      {folderNeedsPermission && (
        <div className="banner warn">
          케이스 폴더 사용 권한이 필요합니다. <button onClick={() => grantFolder()}>폴더 권한 허용</button>{" "}
          <span className="small muted">(허용하기 전에는 이 브라우저 저장소를 씁니다)</span>
        </div>
      )}
    </>
  );
}

function Router() {
  const route = useRoute();
  const { ready } = useApp();
  if (!ready) return <main className="wrap muted">불러오는 중…</main>;
  let page;
  switch (route[0]) {
    case "intake":
      page = <IntakePage />;
      break;
    case "cases":
      page = route[1] ? <CasePage id={route[1]} key={route[1]} /> : <Cases />;
      break;
    case "settings":
      page = <SettingsPage />;
      break;
    case "proof":
      page = <ProofPage />;
      break;
    default:
      page = <Home />;
  }
  // 광고주가 쓰는 화면(질문지 광고주 모드, 시안 확인)에는 내부 메뉴를 보이지 않는다
  const advertiserView = route[0] === "proof" || (route[0] === "intake" && new URLSearchParams(location.hash.split("?")[1] ?? "").get("mode") === "client");
  return (
    <>
      {!advertiserView && <Nav route={route} />}
      {!advertiserView && <Banners />}
      {page}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProvider>
      <Router />
    </AppProvider>
  </StrictMode>,
);
