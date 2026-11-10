import { useEffect, useState } from "react";
import { currentModel, maskSecret, type Effort, type LlmProvider, type ModelProvider, type Secrets, type Settings } from "@/core/settings";
import { normalizeBridgeUrl } from "@/llm/bridgeGenerator";
import { PROVIDER_LABEL, SECRET_FOR, checkConnection } from "@/llm/select";
import { folderSupported, forgetFolder, pickFolder } from "@/storage/folder";
import { clearSecrets, isEncrypted } from "@/storage/prefs";
import { errMsg, useApp } from "../app";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const KEY_PROVIDERS: ModelProvider[] = ["anthropic", "openai", "gemini"];

/** 연결 방식별 안내 */
const KEY_HELP: Record<"anthropic" | "openai" | "gemini", { placeholder: string; note: string }> = {
  anthropic: { placeholder: "sk-ant-…", note: "Anthropic Console에서 이 앱 전용 키를 만들고 지출 한도를 걸어 두기를 권합니다." },
  openai: { placeholder: "sk-…", note: "OpenAI 플랫폼에서 이 앱 전용 프로젝트 키를 만들고 사용 한도를 걸어 두기를 권합니다." },
  gemini: { placeholder: "AIza…", note: "Google AI Studio에서 키를 만듭니다. 무료 등급은 입력 내용이 Google의 서비스 개선에 쓰일 수 있으니 광고주 자료에는 유료 등급 키를 권합니다." },
};

export function SettingsPage() {
  const app = useApp();
  const { settings, secrets, secretsStatus } = app;
  const [draft, setDraft] = useState<Settings>(settings);
  const [newSecret, setNewSecret] = useState<Partial<Record<keyof Secrets, string>>>({});
  const [modelList, setModelList] = useState<Partial<Record<LlmProvider, string[]>>>({});
  const [lock, setLock] = useState(false);
  const [pass, setPass] = useState("");
  const [unlockPass, setUnlockPass] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => setDraft(settings), [settings]);
  useEffect(() => {
    isEncrypted().then(setLock).catch(() => {});
  }, [secretsStatus]);

  const say = (kind: "ok" | "err", text: string) => setMsg({ kind, text });
  const setLlm = (patch: Partial<Settings["llm"]>) => setDraft((d) => ({ ...d, llm: { ...d.llm, ...patch } }));
  const locked = secretsStatus === "locked";
  const provider = draft.llm.provider;
  const secretKey = SECRET_FOR[provider];

  /** 입력칸에 새 값이 있으면 그것을, 없으면 저장된 값을 쓴다 */
  const nextSecrets = (): Secrets => {
    const out: Secrets = { ...secrets };
    for (const [k, v] of Object.entries(newSecret)) if (v?.trim()) out[k as keyof Secrets] = v.trim();
    return out;
  };

  const setModel = (m: string) => {
    if (provider === "fake") return;
    setLlm({ models: { ...draft.llm.models, [provider]: m.trim() } });
  };

  async function save() {
    setMsg(null);
    try {
      const s: Settings = {
        ...draft,
        llm: { ...draft.llm, bridgeUrl: provider === "bridge" ? normalizeBridgeUrl(draft.llm.bridgeUrl) : draft.llm.bridgeUrl },
      };
      await app.updateSettings(s);
      if (!locked) {
        if (lock && !pass) throw new Error("잠그려면 비밀번호를 입력하세요 (이 탭에서만 기억하고 저장하지 않습니다)");
        await app.storeSecrets(nextSecrets(), lock ? pass : undefined);
        setNewSecret({});
      }
      say("ok", currentModel(s) || provider === "fake" ? "저장했습니다. 설정과 키는 이 브라우저에만 저장됩니다." : "저장했습니다. 모델을 아직 고르지 않았습니다 (연결 확인 후 목록에서 고르세요).");
    } catch (e) {
      say("err", errMsg(e));
    }
  }

  async function check() {
    setMsg(null);
    setChecking(true);
    try {
      const secret = secretKey ? (nextSecrets()[secretKey] ?? "") : "";
      const r = await checkConnection(draft, secret);
      setModelList((m) => ({ ...m, [provider]: r.models }));
      say("ok", r.models.length && !r.models.includes(currentModel(draft)) ? `${r.message}. 아래 목록에서 모델을 고르세요.` : r.message);
    } catch (e) {
      say("err", errMsg(e));
    } finally {
      setChecking(false);
    }
  }

  const list = modelList[provider] ?? [];

  return (
    <main className="narrow stack" style={{ maxWidth: 720 }}>
      <h1>설정</h1>
      <p className="small muted">모든 설정과 키는 <b>이 브라우저에만</b> 저장되고 우리 서버로 보내지 않습니다. 다른 PC·브라우저에서는 다시 입력해야 합니다.</p>

      {locked && (
        <div className="card stack">
          <h3>잠긴 키 열기</h3>
          <div className="row">
            <input type="password" placeholder="비밀번호" value={unlockPass} onChange={(e) => setUnlockPass(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
            <button className="primary" onClick={() => app.unlock(unlockPass).then(() => { setPass(unlockPass); setUnlockPass(""); say("ok", "열었습니다"); }, (e) => say("err", errMsg(e)))}>열기</button>
          </div>
        </div>
      )}

      <div className="card stack">
        <h3>LLM 연결</h3>
        <div className="stack small">
          {([...KEY_PROVIDERS, "bridge", ...(import.meta.env.MODE === "fake" ? ["fake"] : [])] as LlmProvider[]).map((p) => (
            <label key={p} className="row">
              <input type="radio" name="provider" checked={provider === p} onChange={() => setLlm({ provider: p })} />
              {PROVIDER_LABEL[p]}
              {p === "bridge" && <span className="muted">(Claude Code 사용자)</span>}
            </label>
          ))}
        </div>

        {(provider === "anthropic" || provider === "openai" || provider === "gemini") && secretKey && (
          <div className="stack">
            <label className="field">
              <span>{PROVIDER_LABEL[provider]} (저장됨: {maskSecret(secrets[secretKey])})</span>
              <input
                type="password"
                autoComplete="off"
                placeholder={`${KEY_HELP[provider].placeholder} (바꿀 때만 입력)`}
                value={newSecret[secretKey] ?? ""}
                onChange={(e) => setNewSecret((s) => ({ ...s, [secretKey]: e.target.value }))}
                disabled={locked}
              />
            </label>
            <p className="small muted">{KEY_HELP[provider].note} 키는 이 브라우저에서 해당 회사 API로만 전송됩니다.</p>
          </div>
        )}

        {provider === "bridge" && (
          <div className="stack">
            <div className="small card" style={{ background: "var(--bg)" }}>
              <b>브리지 실행 방법</b> (Claude Code가 설치·로그인된 PC에서)
              <ol style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                <li>브리지 파일을 받아 터미널에서 <code>node bridge.mjs</code> 실행</li>
                <li>화면에 나온 <b>연결 코드</b>를 아래에 붙여 넣기</li>
                <li>"연결 확인"을 누르고, 브라우저가 로컬 네트워크 접근을 물으면 허용</li>
              </ol>
              <div className="muted" style={{ marginTop: 6 }}>생성은 이 PC의 Claude Code 로그인(구독)으로 실행됩니다. 브리지는 이 PC(127.0.0.1)에서만 열립니다.</div>
            </div>
            <label className="field">
              <span>브리지 주소</span>
              <input type="url" value={draft.llm.bridgeUrl} onChange={(e) => setLlm({ bridgeUrl: e.target.value })} />
            </label>
            <label className="field">
              <span>연결 코드 (저장됨: {maskSecret(secrets.bridgeToken)})</span>
              <input
                type="password"
                autoComplete="off"
                placeholder="브리지 화면의 연결 코드 (바꿀 때만 입력)"
                value={newSecret.bridgeToken ?? ""}
                onChange={(e) => setNewSecret((s) => ({ ...s, bridgeToken: e.target.value }))}
                disabled={locked}
              />
            </label>
          </div>
        )}

        {provider !== "fake" && (
          <div className="row">
            <label className="field" style={{ flex: 1, minWidth: 220 }}>
              <span>모델 {list.length > 0 && <>(목록 {list.length}개)</>}</span>
              {list.length > 0 ? (
                <select value={list.includes(currentModel(draft)) ? currentModel(draft) : ""} onChange={(e) => setModel(e.target.value)} style={{ width: "100%" }}>
                  <option value="" disabled>모델을 고르세요</option>
                  {list.map((m) => <option key={m}>{m}</option>)}
                </select>
              ) : (
                <input type="text" placeholder="연결 확인을 누르면 목록이 나옵니다" value={currentModel(draft)} onChange={(e) => setModel(e.target.value)} />
              )}
            </label>
            <label className="field">
              <span>추론 강도</span>
              <select value={draft.llm.effort} onChange={(e) => setLlm({ effort: e.target.value as Effort })}>
                {EFFORTS.map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            {provider !== "bridge" && (
              <label className="field">
                <span>최대 토큰</span>
                <input type="text" inputMode="numeric" style={{ width: 110 }} value={draft.llm.maxTokens} onChange={(e) => setLlm({ maxTokens: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
              </label>
            )}
          </div>
        )}
        {provider !== "fake" && (
          <p className="small muted">
            추론 강도는 모델마다 지원 범위가 다릅니다 (OpenAI는 추론 모델에만, Gemini는 3 계열에만 적용). 브리프·아이디어는 결과를 코드로 검증하므로 어떤 모델이든 같은 규칙이 적용됩니다.
          </p>
        )}
        <div className="row">
          <button onClick={check} disabled={checking || locked}>{checking ? "확인 중…" : "연결 확인"}</button>
        </div>
      </div>

      <div className="card stack">
        <h3>외부 디자인 도구</h3>
        <label className="field">
          <span>Figma 개인 액세스 토큰 (선택, 저장됨: {maskSecret(secrets.figmaToken)})</span>
          <input type="password" autoComplete="off" placeholder="figd_… (바꿀 때만 입력)" value={newSecret.figmaToken ?? ""} onChange={(e) => setNewSecret((s) => ({ ...s, figmaToken: e.target.value }))} disabled={locked} />
        </label>
        <p className="small muted">Figma 템플릿·브랜드 자산 읽기에 씁니다(합성 단계에서 사용 예정). Figma REST API로는 파일을 편집할 수 없습니다.</p>
        <p className="small muted">Canva 연결은 OAuth 중계 서버가 필요해 2차에서 지원합니다.</p>
      </div>

      <div className="card stack">
        <h3>키 보호</h3>
        <label className="row small">
          <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} disabled={locked} />
          비밀번호로 키 잠그기 (탭을 새로 열 때마다 비밀번호 입력)
        </label>
        {lock && !locked && (
          <input type="password" placeholder="비밀번호 (저장하지 않음, 잊으면 키를 다시 입력해야 함)" value={pass} onChange={(e) => setPass(e.target.value)} />
        )}
        <div className="row">
          <button
            onClick={async () => {
              if (!confirm("이 브라우저에 저장된 API 키·연결 코드·토큰을 모두 지웁니다.")) return;
              await clearSecrets();
              await app.storeSecrets({});
              say("ok", "키를 모두 지웠습니다");
            }}
          >
            저장된 키 모두 지우기
          </button>
        </div>
      </div>

      <div className="card stack">
        <h3>케이스 저장 위치</h3>
        <p className="small">현재: <b>{app.store.label}</b></p>
        {folderSupported() ? (
          <div className="row">
            <button
              onClick={async () => {
                try {
                  await pickFolder();
                  await app.reloadStore();
                  say("ok", "고른 폴더에 케이스를 저장합니다. 이전 브라우저 저장소의 케이스는 '케이스 파일 내보내기'로 옮기세요.");
                } catch (e) {
                  if ((e as Error).name !== "AbortError") say("err", errMsg(e));
                }
              }}
            >
              PC 폴더 고르기
            </button>
            {app.store.kind === "folder" && (
              <button onClick={async () => { await forgetFolder(); await app.reloadStore(); say("ok", "브라우저 저장소로 돌아왔습니다"); }}>폴더 연결 해제</button>
            )}
          </div>
        ) : (
          <p className="small muted">이 브라우저는 PC 폴더 저장을 지원하지 않습니다 (Chrome·Edge 지원). 브라우저 저장소를 씁니다.</p>
        )}
        <p className="small muted">브라우저 저장소는 브라우저 데이터를 지우면 함께 지워집니다. 중요한 케이스는 내보내기로 백업하세요.</p>
      </div>

      <div className="card small stack">
        <h3>미정 항목 (운영 결정 전)</h3>
        <div>수정 포함 횟수: {String(settings.revision.includedCount)} ({settings.revision.includedCountRange}) · 가격: {settings.pricing} · 개인정보 보관: {settings.privacyRetention} · 이미지 모델: {settings.imageModel}</div>
      </div>

      {msg && <p className={`card ${msg.kind === "err" ? "err" : "okc"}`}>{msg.text}</p>}
      <div className="bottombar">
        <div className="inner" style={{ maxWidth: 720 }}>
          <span className="small muted">저장 전에는 바뀐 설정이 적용되지 않습니다</span>
          <button className="primary" onClick={save}>저장</button>
        </div>
      </div>
    </main>
  );
}
