// 데스크톱 실행파일의 화면(app://ad-agent)에만 여는 작은 창구: 이 PC의 Claude CLI 로 구조화 생성.
// 화면 쪽에는 이 두 함수만 보이고, 다른 Node·Electron 기능은 열지 않는다.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("adAgentDesktop", {
  version: 1,
  claude: {
    /** claude 를 찾고 버전을 확인한다. claudePath 를 비우면 자동으로 찾는다 */
    check: (claudePath) => ipcRenderer.invoke("claude:check", typeof claudePath === "string" ? claudePath : ""),
    /** { system, user, jsonSchema, model, effort, images?, claudePath? } → 브리지와 같은 응답 */
    generate: (req) => ipcRenderer.invoke("claude:generate", req),
  },
});
