import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { CaseService } from "@/core/caseService";
import { DEFAULT_SETTINGS, type Secrets, type Settings } from "@/core/settings";
import { IdbStore } from "@/storage/idb";
import { FolderStore, ensurePermission, savedFolder } from "@/storage/folder";
import type { CaseStore } from "@/storage/types";
import { loadSecrets, loadSettings, saveSecrets, saveSettings, unlockSecrets } from "@/storage/prefs";
import { createGenerator } from "@/llm/select";
import type { Generator } from "@/llm/generator";

/* ---------------- 해시 라우터 (GitHub Pages에서 새로고침해도 404가 안 나게) ---------------- */

export function useRoute(): string[] {
  const read = () =>
    (location.hash.replace(/^#\/?/, "").split("?")[0] || "").split("/").filter(Boolean).map(decodeURIComponent);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parts;
}

export const href = (...parts: string[]) => `#/${parts.map(encodeURIComponent).join("/")}`;
export const go = (...parts: string[]) => {
  location.hash = href(...parts);
};

/* ---------------- 앱 상태 ---------------- */

type SecretsStatus = "loading" | "empty" | "ready" | "locked";

interface AppState {
  settings: Settings;
  updateSettings: (s: Settings) => Promise<void>;
  secrets: Secrets;
  secretsStatus: SecretsStatus;
  unlock: (passphrase: string) => Promise<void>;
  storeSecrets: (s: Secrets, passphrase?: string) => Promise<void>;
  store: CaseStore;
  svc: CaseService;
  /** 폴더를 골랐지만 이번 방문에 권한을 아직 받지 않은 경우 */
  folderNeedsPermission: boolean;
  grantFolder: () => Promise<void>;
  reloadStore: () => Promise<void>;
  generator: () => Generator;
  ready: boolean;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("AppProvider 밖에서 useApp을 썼습니다");
  return v;
}

const isFakeMode = import.meta.env.MODE === "fake";

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [secrets, setSecrets] = useState<Secrets>({});
  const [secretsStatus, setSecretsStatus] = useState<SecretsStatus>("loading");
  const [store, setStore] = useState<CaseStore>(() => new IdbStore());
  const [folderNeedsPermission, setFolderNeedsPermission] = useState(false);
  const [ready, setReady] = useState(false);

  const reloadStore = useCallback(async () => {
    const handle = await savedFolder().catch(() => null);
    if (handle) {
      if (await ensurePermission(handle, false)) {
        setStore(new FolderStore(handle));
        setFolderNeedsPermission(false);
        return;
      }
      setFolderNeedsPermission(true);
    } else setFolderNeedsPermission(false);
    setStore(new IdbStore());
  }, []);

  useEffect(() => {
    (async () => {
      const s = await loadSettings();
      // 가짜 모드(개발용 화면 시험)는 저장된 설정과 상관없이 가짜 모델을 쓴다
      if (isFakeMode) s.llm.provider = "fake";
      setSettings(s);
      const sec = await loadSecrets();
      if (sec.status === "plain") {
        setSecrets(sec.secrets);
        setSecretsStatus("ready");
      } else setSecretsStatus(sec.status);
      await reloadStore();
      setReady(true);
    })();
  }, [reloadStore]);

  const value = useMemo<AppState>(() => {
    const svc = new CaseService(store, () => settings);
    return {
      settings,
      updateSettings: async (s) => {
        setSettings(s);
        await saveSettings(s);
      },
      secrets,
      secretsStatus,
      unlock: async (passphrase) => {
        setSecrets(await unlockSecrets(passphrase));
        setSecretsStatus("ready");
      },
      storeSecrets: async (s, passphrase) => {
        await saveSecrets(s, passphrase);
        setSecrets(s);
        setSecretsStatus(Object.values(s).some(Boolean) ? "ready" : "empty");
      },
      store,
      svc,
      folderNeedsPermission,
      grantFolder: async () => {
        const handle = await savedFolder();
        if (handle && (await ensurePermission(handle, true))) {
          setStore(new FolderStore(handle));
          setFolderNeedsPermission(false);
        }
      },
      reloadStore,
      generator: () => createGenerator(settings, secrets),
      ready,
    };
  }, [settings, secrets, secretsStatus, store, folderNeedsPermission, reloadStore, ready]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/* ---------------- 파일 내려받기·읽기 ---------------- */

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickJsonFile(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return reject(new Error("파일을 고르지 않았습니다"));
      if (f.size > 20 * 1024 * 1024) return reject(new Error("파일이 너무 큽니다 (20MB 이하)"));
      try {
        resolve(JSON.parse(await f.text()));
      } catch {
        reject(new Error("JSON 파일이 아닙니다"));
      }
    };
    input.click();
  });
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : "알 수 없는 오류");
