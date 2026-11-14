// 광고 시안 에이전트 — 데스크톱(Electron) 실행파일
// 웹 배포본과 같은 화면(dist/)을 app://ad-agent/ 주소로 띄운다.
//  - 케이스 데이터·키는 웹판과 같이 이 PC 안(앱의 IndexedDB 또는 고른 폴더)에만 저장한다. 서버로 보내지 않는다.
//  - file:// 대신 전용 주소를 쓰는 이유: IndexedDB·폴더 저장소·LLM API 호출(CORS)이 보통 웹 주소처럼 동작해야 한다.
//  - Claude CLI 브리지는 웹판과 같이 따로 실행한다 (브리지 0.2.2 이상이 이 주소를 허용).
const { app, BrowserWindow, Menu, net, protocol, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SCHEME = "app";
const HOST = "ad-agent";
const START = `${SCHEME}://${HOST}/index.html`;
const DIST = path.join(__dirname, "..", "dist");

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// 같은 앱을 두 번 열면 이미 열린 창을 앞으로
if (!app.requestSingleInstanceLock()) app.quit();

function serveDist() {
  protocol.handle(SCHEME, (req) => {
    const url = new URL(req.url);
    if (url.host !== HOST) return new Response("not found", { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const file = path.normalize(path.join(DIST, rel));
    // dist 밖의 파일은 주지 않는다
    if (file !== DIST && !file.startsWith(DIST + path.sep)) return new Response("forbidden", { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

const isExternal = (u) => /^https?:\/\//i.test(u);

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: `광고 시안 에이전트 v${app.getVersion()}`,
    icon: path.join(__dirname, "..", "build", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  // 바깥 주소(도움말의 GitHub 링크, Figma 등)는 기본 브라우저로 연다
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`${SCHEME}://${HOST}/`)) {
      e.preventDefault();
      if (isExternal(url)) shell.openExternal(url);
    }
  });
  // 페이지 제목 대신 앱 이름·버전을 창 제목으로 유지
  win.on("page-title-updated", (e) => e.preventDefault());
  win.loadURL(START);
  return win;
}

app.on("second-instance", () => {
  const [w] = BrowserWindow.getAllWindows();
  if (w) {
    if (w.isMinimized()) w.restore();
    w.focus();
  }
});

app.whenReady().then(() => {
  serveDist();
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: "appMenu" }] : []),
      { label: "파일", submenu: [{ role: "reload", label: "새로 고침" }, { type: "separator" }, isMac ? { role: "close", label: "닫기" } : { role: "quit", label: "끝내기" }] },
      { label: "편집", submenu: [{ role: "undo", label: "실행 취소" }, { role: "redo", label: "다시 실행" }, { type: "separator" }, { role: "cut", label: "잘라내기" }, { role: "copy", label: "복사" }, { role: "paste", label: "붙여넣기" }, { role: "selectAll", label: "모두 선택" }] },
      { label: "보기", submenu: [{ role: "resetZoom", label: "원래 크기" }, { role: "zoomIn", label: "확대" }, { role: "zoomOut", label: "축소" }, { type: "separator" }, { role: "togglefullscreen", label: "전체 화면" }, { role: "toggleDevTools", label: "개발자 도구" }] },
      { label: "도움말", submenu: [
        { label: "도움말 보기", click: () => BrowserWindow.getFocusedWindow()?.loadURL(`${START}#/help`) },
        { label: "GitHub 저장소", click: () => shell.openExternal("https://github.com/samcho93/ad-agent") },
        { label: "웹에서 열기", click: () => shell.openExternal("https://samcho93.github.io/ad-agent/") },
      ] },
    ]),
  );
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
