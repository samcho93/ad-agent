// 광고 시안 에이전트 — 데스크톱(Electron) 실행파일
// 웹 배포본과 같은 화면(dist/)을 app://ad-agent/ 주소로 띄운다.
//  - 케이스 데이터·키는 웹판과 같이 이 PC 안(앱의 IndexedDB 또는 고른 폴더)에만 저장한다. 서버로 보내지 않는다.
//  - file:// 대신 전용 주소를 쓰는 이유: IndexedDB·폴더 저장소·LLM API 호출(CORS)이 보통 웹 주소처럼 동작해야 한다.
//  - Claude CLI: 이 앱은 브리지 없이 이 PC의 claude 를 직접 실행한다 (설정의 "이 PC의 Claude CLI").
//    실행 코드는 bridge/bridge.mjs 의 것을 그대로 불러 쓴다. 화면에는 preload.cjs 의 두 함수만 연다.
const { app, BrowserWindow, Menu, ipcMain, net, protocol, shell } = require("electron");
const fs = require("node:fs");
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

/* ---------------- 이 PC의 Claude CLI (브리지 없이) ---------------- */

let bridgeCore = null;
const core = () => (bridgeCore ??= import(pathToFileURL(path.join(__dirname, "..", "bridge", "bridge.mjs")).href));
const MAX_RUNNING = 2;
let running = 0;

/** 화면에서 넘어온 claude 경로: 직접 지정한 경우 실제 claude 실행 파일만 받는다 (다른 프로그램 실행 방지) */
function checkedPath(p) {
  const v = typeof p === "string" ? p.trim().replace(/^"|"$/g, "") : "";
  if (!v) return "";
  if (!path.isAbsolute(v)) throw new Error("claude 경로는 전체 경로로 적어 주세요 (예: C:\\Users\\이름\\.local\\bin\\claude.exe)");
  const base = path.basename(v).toLowerCase();
  if (base === "claude.cmd" || base === "claude.ps1") throw new Error("claude.cmd 가 아니라 실제 실행 파일(claude.exe)의 경로를 적어 주세요");
  if (!/^claude(\.exe)?$/.test(base)) throw new Error("claude 실행 파일(claude 또는 claude.exe)의 경로만 쓸 수 있습니다");
  let st;
  try {
    st = fs.statSync(v);
  } catch {
    throw new Error(`파일이 없습니다: ${v}`);
  }
  if (!st.isFile()) throw new Error(`파일이 아닙니다: ${v}`);
  return v;
}

async function findClaude(p) {
  const m = await core();
  const bin = m.resolveClaude(checkedPath(p) || undefined);
  if (!bin) throw new Error("이 PC에서 claude(Claude Code CLI)를 찾지 못했습니다. Claude Code를 설치·로그인하거나, 설정에 claude.exe 경로를 적어 주세요");
  return { m, bin };
}

const fromApp = (e) => {
  const url = e.senderFrame?.url ?? "";
  return url.startsWith(`${SCHEME}://${HOST}/`);
};

// 오류는 { ok: false, error } 로 돌려준다 (ipc 의 긴 오류 문구 대신 쉬운 말이 화면에 나오게)
const safe = (fn) => async (e, arg) => {
  if (!fromApp(e)) return { ok: false, error: "허용되지 않은 화면" };
  try {
    return { ok: true, ...(await fn(arg)) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

ipcMain.handle(
  "claude:check",
  safe(async (p) => {
    const { m, bin } = await findClaude(p);
    return { path: bin, version: await m.claudeVersion(bin), core: m.VERSION };
  }),
);

ipcMain.handle(
  "claude:generate",
  safe(async (req) => {
    const { m, bin } = await findClaude(req?.claudePath);
    const body = { system: req?.system, user: req?.user, jsonSchema: req?.jsonSchema, model: req?.model, effort: req?.effort, ...(req?.images ? { images: req.images } : {}) };
    const bad = m.validateGenerate(body);
    if (bad) throw new Error(bad);
    if (running >= MAX_RUNNING) throw new Error("이미 생성 중인 작업이 있습니다. 잠시 후 다시 시도하세요");
    running++;
    try {
      return { result: await m.runClaude(bin, body) };
    } finally {
      running--;
    }
  }),
);

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: `광고 시안 에이전트 v${app.getVersion()}`,
    icon: path.join(__dirname, "..", "build", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, preload: path.join(__dirname, "preload.cjs") },
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
