import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImageService } from "@/core/imageService";
import { ASSET_KIND_LABEL, ROUTE_LABEL, applicableCriteria, type AssetKind, type ImageItem, type ImagesDoc } from "@/core/images";
import { generateImagePrompt } from "@/llm/imagePipeline";
import { fetchFigmaFramePng } from "@/integrations/figma";
import { CUTOUT_TOOL, removeBackground } from "@/integrations/cutout";
import { errMsg, useApp } from "../app";

const IMAGE_TYPES = "image/png,image/jpeg,image/webp";

function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.click();
  });
}

/** 저장소의 이미지 파일을 화면에 보여 줄 주소로 (탭을 떠나면 해제) */
function useBlobUrls(caseId: string, files: string[]) {
  const { store } = useApp();
  const [urls, setUrls] = useState<Record<string, string>>({});
  const made = useRef<Record<string, string>>({});
  const key = files.join("|");
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const f of files) {
        if (made.current[f]) continue;
        const b = await store.readBlob(caseId, f);
        if (!b || !alive) continue;
        made.current[f] = URL.createObjectURL(b);
      }
      if (alive) setUrls({ ...made.current });
    })();
    return () => {
      alive = false;
    };
  }, [caseId, key, store]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => Object.values(made.current).forEach((u) => URL.revokeObjectURL(u)), []);
  return urls;
}

const CHECKER: React.CSSProperties = {
  backgroundImage: "linear-gradient(45deg,#ddd 25%,transparent 25%),linear-gradient(-45deg,#ddd 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ddd 75%),linear-gradient(-45deg,transparent 75%,#ddd 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0,0 8px,8px -8px,-8px 0",
};

export function ImagesSection({ caseId, name, onChanged }: { caseId: string; name: string; onChanged: () => void }) {
  const { svc, generator, secrets } = useApp();
  const images = useMemo(() => new ImageService(svc), [svc]);
  const [doc, setDoc] = useState<ImagesDoc | null>(null);
  const [ready, setReady] = useState<{ ok: boolean; blockers: string[] }>({ ok: false, blockers: [] });
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [progress, setProgress] = useState("");
  const [assetKind, setAssetKind] = useState<AssetKind>("product");
  const [figmaLink, setFigmaLink] = useState("");
  const [promptForImport, setPromptForImport] = useState("");
  const [uploadTool, setUploadTool] = useState("Figma (PNG로 내보내기)");
  const [pasteTool, setPasteTool] = useState("Figma (PNG로 복사)");

  const reload = useCallback(async () => {
    let d = await images.getDoc(caseId);
    if (!d.policy) d = await images.refreshPolicy(caseId);
    setDoc(d);
    setReady(await images.readiness(caseId));
  }, [images, caseId]);

  useEffect(() => {
    reload().catch((e) => setErr(errMsg(e)));
  }, [reload]);

  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label);
    setErr("");
    try {
      await work();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setProgress("");
      await reload().catch(() => {});
      onChanged();
      setBusy("");
    }
  };
  const needName = () => {
    if (!name.trim()) {
      setErr("화면 위쪽(또는 아래 승인 칸)의 이름을 먼저 적어 주세요. 이미지 기록에 남습니다");
      return true;
    }
    return false;
  };

  const files = useMemo(() => [...(doc?.assets.map((a) => a.file) ?? []), ...(doc?.items.map((i) => i.file) ?? [])], [doc]);
  const urls = useBlobUrls(caseId, files);

  if (!doc) return <p className="muted">이미지 단계를 불러오는 중…</p>;
  const policy = doc.policy;
  const latestPrompt = doc.prompts[doc.prompts.length - 1];
  const productRoute = policy?.route === "product_cutout" || policy?.route === "product_regenerate";
  const visibleItems = doc.items.filter((i) => i.status !== "discarded");
  const discarded = doc.items.length - visibleItems.length;

  return (
    <div className="stack">
      {err && <p className="err card">{err}</p>}

      {/* 1. 자료 */}
      <div className="card stack">
        <h3>자료 (광고주 제공 사진·로고)</h3>
        <div className="row">
          <select value={assetKind} onChange={(e) => setAssetKind(e.target.value as AssetKind)}>
            {(Object.keys(ASSET_KIND_LABEL) as AssetKind[]).map((k) => <option key={k} value={k}>{ASSET_KIND_LABEL[k]}</option>)}
          </select>
          <button
            disabled={!!busy}
            onClick={async () => {
              if (needName()) return;
              const fs = await pickFiles(assetKind === "logo" ? `${IMAGE_TYPES},image/svg+xml` : IMAGE_TYPES, true);
              if (fs.length) run("asset", async () => { for (const f of fs) await images.addAsset(caseId, f, f.name, assetKind, name); });
            }}
          >
            {busy === "asset" ? "올리는 중…" : "파일 올리기"}
          </button>
          <span className="small muted">이 PC(선택한 저장 위치)에만 저장됩니다.</span>
        </div>
        {doc.assets.length === 0 ? <p className="small muted">아직 올린 자료가 없습니다.</p> : (
          <div className="row" style={{ alignItems: "flex-start" }}>
            {doc.assets.map((a) => (
              <div key={a.id} className="card small" style={{ width: 150, padding: 8 }}>
                {urls[a.file] && <img src={urls[a.file]} alt={a.originalName} style={{ width: "100%", height: 100, objectFit: "contain", ...CHECKER }} />}
                <div><b>{ASSET_KIND_LABEL[a.kind]}</b></div>
                <div className="muted" style={{ wordBreak: "break-all" }}>{a.originalName}</div>
                <button className="small" disabled={!!busy} onClick={() => confirm("이 자료를 지울까요?") && run("rm", () => images.removeAsset(caseId, a.id, name))}>지우기</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 2. 방침 */}
      {policy && (
        <div className="card stack small">
          <h3>이미지 방침 (ad-image-router)</h3>
          <div><b>경로:</b> {ROUTE_LABEL[policy.route]}</div>
          <div className="muted">{policy.reason}{policy.medical ? " · 의료: 시술·전후 비교로 보이는 AI 이미지 금지" : ""}</div>
          {policy.blockers.map((b) => <div key={b} className="warn">✗ {b}</div>)}
          {policy.clientRequests.length > 0 && <div><b>광고주 확인·요청:</b> {policy.clientRequests.join(" · ")}</div>}
          <details>
            <summary>검수 기준 ({policy.qaCriteria.length})</summary>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{policy.qaCriteria.map((c) => <li key={c}>{c}</li>)}</ul>
          </details>
        </div>
      )}

      {/* 3. 프롬프트 */}
      <div className="card stack small">
        <h3>이미지 프롬프트</h3>
        <p className="muted">고른 아이디어로 프롬프트를 만듭니다. 복사해서 Figma(또는 쓰는 이미지 도구)에 넣으세요. "글자·로고 금지"와 빈 공간 위치는 자동으로 붙습니다.</p>
        <div className="row">
          <button
            className="primary"
            disabled={!!busy || policy?.route === "product_need_photo"}
            onClick={() => run("prompt", () => generateImagePrompt(svc, images, caseId, generator()))}
          >
            {busy === "prompt" ? "프롬프트 만드는 중…" : latestPrompt ? "프롬프트 다시 만들기" : "프롬프트 만들기"}
          </button>
        </div>
        {latestPrompt && (
          <div className="stack">
            <div className="muted">{latestPrompt.id} · {latestPrompt.model} · 비율 {latestPrompt.aspect} · 빈 공간 {latestPrompt.copySpace}</div>
            <pre className="card" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{latestPrompt.promptEn}</pre>
            <div className="row">
              <button onClick={() => navigator.clipboard.writeText(latestPrompt.promptEn)}>영어 프롬프트 복사</button>
            </div>
            <div>{latestPrompt.promptKo}</div>
            {latestPrompt.issues.map((i, k) => <div key={k} className={i.severity === "error" ? "err" : "warn"}>⚠ {i.message}</div>)}
          </div>
        )}
      </div>

      {/* 4. 가져오기 */}
      <div className="card stack small">
        <h3>이미지 가져오기</h3>
        <label className="field">
          <span>어떤 프롬프트로 만든 이미지인가요? (기록용)</span>
          <select value={promptForImport} onChange={(e) => setPromptForImport(e.target.value)}>
            <option value="">프롬프트 없음 / 실제 사진</option>
            {doc.prompts.map((p) => <option key={p.id} value={p.id}>{p.id} — {p.promptKo.slice(0, 40)}</option>)}
          </select>
        </label>
        <div className="row">
          <input type="url" placeholder="Figma 프레임 링크 (프레임 선택 → 선택 항목 링크 복사)" value={figmaLink} onChange={(e) => setFigmaLink(e.target.value)} style={{ flex: 1, minWidth: 260 }} />
          <button
            disabled={!!busy || !figmaLink.trim()}
            onClick={() => {
              if (needName()) return;
              run("figma", async () => {
                const r = await fetchFigmaFramePng(secrets.figmaToken ?? "", figmaLink);
                await images.addImage(caseId, r.blob, { source: "figma", role: "scene", tool: "Figma (REST 렌더링)", promptId: promptForImport || undefined, figma: { fileKey: r.fileKey, nodeId: r.nodeId } }, name);
                setFigmaLink("");
              });
            }}
          >
            {busy === "figma" ? "가져오는 중…" : "Figma에서 가져오기"}
          </button>
        </div>
        <div className="row">
          <input type="text" placeholder="사용한 도구 (기록용)" value={uploadTool} onChange={(e) => setUploadTool(e.target.value)} style={{ width: 260 }} />
          <button
            disabled={!!busy || !uploadTool.trim()}
            onClick={async () => {
              if (needName()) return;
              const fs = await pickFiles(IMAGE_TYPES, true);
              if (fs.length) run("upload", async () => { for (const f of fs) await images.addImage(caseId, f, { source: "upload", role: "scene", tool: uploadTool.trim(), promptId: promptForImport || undefined }, name); });
            }}
          >
            {busy === "upload" ? "올리는 중…" : "직접 올리기"}
          </button>
        </div>
        <div className="row">
          <input type="text" placeholder="사용한 도구 (기록용)" value={pasteTool} onChange={(e) => setPasteTool(e.target.value)} style={{ width: 260 }} />
        </div>
        <div
          tabIndex={0}
          role="button"
          aria-label="여기를 누르고 Ctrl+V 로 이미지 붙여넣기"
          className="card"
          style={{ borderStyle: "dashed", textAlign: "center", padding: 18, cursor: "copy", outlineOffset: 2 }}
          onPaste={(e) => {
            e.preventDefault();
            const files = [...e.clipboardData.items].filter((it) => it.kind === "file" && it.type.startsWith("image/")).map((it) => it.getAsFile()).filter((f): f is File => !!f);
            if (!files.length) return setErr("붙여 넣은 내용에 이미지가 없습니다. Figma에서 프레임을 고르고 Ctrl+Shift+C(PNG로 복사) 했는지 확인하세요");
            if (needName() || !pasteTool.trim()) return;
            run("paste", async () => { for (const f of files) await images.addImage(caseId, f, { source: "upload", role: "scene", tool: pasteTool.trim(), promptId: promptForImport || undefined }, name); });
          }}
        >
          {busy === "paste" ? "붙여 넣는 중…" : (
            <>
              <b>여기를 누르고 Ctrl+V</b> 로 이미지 붙여넣기
              <div className="muted">Figma: 프레임 선택 → Ctrl+Shift+C (PNG로 복사). Figma API 한도를 쓰지 않아 무료 플랜에서도 제한 없이 쓸 수 있습니다.</div>
            </>
          )}
        </div>
        <p className="muted">가져온 이미지는 바로 저장되고, 도구·프롬프트·날짜가 기록됩니다.</p>
      </div>

      {/* 5. 누끼 */}
      {productRoute && (
        <div className="card stack small">
          <h3>제품 누끼 (브라우저 안에서)</h3>
          <p className="muted">
            제품 사진의 배경만 투명하게 만듭니다. 사진은 이 PC 밖으로 나가지 않고, 제품 픽셀은 바뀌지 않습니다(투명도만 계산). 처음 한 번 모델(약 115~180MB)을 받아 브라우저에 보관합니다. GPU가 없거나 약하면 CPU로 계산해 1~2분 걸릴 수 있습니다.
          </p>
          {doc.assets.filter((a) => a.kind === "product").length === 0 && <p className="warn">먼저 자료에 제품 사진을 올리세요.</p>}
          <div className="row" style={{ alignItems: "flex-start" }}>
            {doc.assets.filter((a) => a.kind === "product").map((a) => (
              <div key={a.id} className="card" style={{ width: 170, padding: 8 }}>
                {urls[a.file] && <img src={urls[a.file]} alt={a.originalName} style={{ width: "100%", height: 110, objectFit: "contain" }} />}
                <button
                  disabled={!!busy}
                  onClick={() => {
                    if (needName()) return;
                    run(`cut:${a.id}`, async () => {
                      const photo = await svc.store.readBlob(caseId, a.file);
                      if (!photo) throw new Error("사진 파일을 읽지 못했습니다");
                      const r = await removeBackground(photo, setProgress);
                      await images.addImage(caseId, r.blob, { source: "cutout", role: "cutout", tool: `${CUTOUT_TOOL}, ${r.device}`, fromAssetId: a.id }, name);
                    });
                  }}
                >
                  {busy === `cut:${a.id}` ? "누끼 중…" : "자동 누끼"}
                </button>
              </div>
            ))}
          </div>
          {progress && <p className="muted">{progress}</p>}
        </div>
      )}

      {/* 6. 갤러리 */}
      <h3>이미지 후보 {visibleItems.length > 0 && <span className="small muted">({visibleItems.length}장{discarded ? `, 버린 것 ${discarded}장` : ""})</span>}</h3>
      {visibleItems.length === 0 && <p className="small muted">아직 가져온 이미지가 없습니다.</p>}
      <div className="ideas">
        {visibleItems.map((it) => (
          <ImageCard
            key={it.id}
            item={it}
            doc={doc}
            url={urls[it.file]}
            originalUrl={it.fromAssetId ? urls[doc.assets.find((a) => a.id === it.fromAssetId)?.file ?? ""] : undefined}
            busy={!!busy}
            onPatch={(patch) => { if (!needName()) run(`item:${it.id}`, () => images.updateImage(caseId, it.id, patch, name)); }}
          />
        ))}
      </div>

      {/* 7. 확정 */}
      <div className="card stack small">
        <h3>이미지 확정</h3>
        {ready.ok ? <div className="okc">✓ 확정할 수 있습니다</div> : ready.blockers.map((b) => <div key={b} className="warn">✗ {b}</div>)}
        <div className="row">
          <button className="primary" disabled={!!busy || !ready.ok || !name.trim()} onClick={() => run("complete", () => images.complete(caseId, name))}>
            이미지 확정 (합성 단계로)
          </button>
        </div>
      </div>
    </div>
  );
}

function ImageCard({ item, doc, url, originalUrl, busy, onPatch }: {
  item: ImageItem; doc: ImagesDoc; url?: string; originalUrl?: string; busy: boolean; onPatch: (p: Partial<ImageItem>) => void;
}) {
  const criteria = applicableCriteria(item, doc.policy);
  const prompt = doc.prompts.find((p) => p.id === item.promptId);
  return (
    <div className={`card stack small ${item.status === "picked" ? "idea on" : ""}`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b>{item.role === "cutout" ? "제품 누끼" : "배경·장면"}</b>
        <span className="muted">{item.status === "picked" ? "✓ 선택됨" : "후보"}</span>
      </div>
      <div className="row" style={{ gap: 6 }}>
        {originalUrl && <img src={originalUrl} alt="원본" title="원본" style={{ width: "48%", height: 150, objectFit: "contain" }} />}
        {url ? <img src={url} alt={item.id} style={{ width: originalUrl ? "48%" : "100%", height: originalUrl ? 150 : 200, objectFit: "contain", ...CHECKER }} /> : <div className="muted">불러오는 중…</div>}
      </div>
      <div className="muted">{item.tool} · {new Date(item.createdAt).toLocaleString("ko-KR")} · {item.createdBy}</div>
      {prompt && <div className="muted">프롬프트: {prompt.id}</div>}
      {item.figma && <div className="muted">Figma: {item.figma.fileKey} / {item.figma.nodeId}</div>}
      <label className="row">
        <input type="checkbox" checked={item.commercialUseChecked} disabled={busy} onChange={(e) => onPatch({ commercialUseChecked: e.target.checked })} />
        {item.role === "cutout" ? "원본 사진은 광고주가 제공한 것이고 광고에 써도 된다" : "이 이미지를 만든 도구의 상업 이용 허용을 확인했다"}
      </label>
      {criteria.map((c) => (
        <label key={c} className="row">
          <input type="checkbox" checked={!!item.checks[c]} disabled={busy} onChange={(e) => onPatch({ checks: { [c]: e.target.checked } })} />
          {c}
        </label>
      ))}
      <div className="row">
        {item.status !== "picked" ? (
          <button className="primary" disabled={busy} onClick={() => onPatch({ status: "picked" })}>이 이미지 고르기</button>
        ) : (
          <button disabled={busy} onClick={() => onPatch({ status: "candidate" })}>선택 취소</button>
        )}
        <button disabled={busy} onClick={() => confirm("이 이미지를 버릴까요? (파일과 기록은 남습니다)") && onPatch({ status: "discarded" })}>버리기</button>
      </div>
    </div>
  );
}
