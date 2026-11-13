import { useEffect, useMemo, useRef, useState } from "react";
import { ComposeService } from "@/core/composeService";
import { DeliveryService } from "@/core/deliveryService";
import { type ComposeDoc, type SizeKey, type Variant, sizeOf, sizeShape } from "@/core/compose";
import type { DeliveryDoc } from "@/core/delivery";
import { parseSizeText } from "@/core/intake";
import { loadFonts } from "@/render/fonts";
import { canvasToPng, loadComposeSources, renderBanner, type RenderCheck, type Sources } from "@/render/composeCanvas";
import { errMsg, useApp } from "../app";

const SHAPE_LABEL = { band: "띠형 배치", landscape: "가로형 배치", square: "정사각·세로형 배치" } as const;

/**
 * 변형 단계: 광고주가 고른 시안을 다른 매체·사이즈로 더 만든다.
 * 문구·그림은 고른 시안 그대로, 배치만 사이즈에 맞춘다. 저장 뒤 사람이 잘림·겹침·가독성을 확인한다.
 */
export function VariantSizes({ caseId, name, doc, maxKB, suggestedSize, onChanged }: {
  caseId: string; name: string; doc: DeliveryDoc; maxKB: number | null; suggestedSize: string; onChanged: () => void;
}) {
  const { svc, store } = useApp();
  const dsvc = useMemo(() => new DeliveryService(svc), [svc]);
  const compose = useMemo(() => new ComposeService(svc), [svc]);
  const [cdoc, setCdoc] = useState<ComposeDoc | null>(null);
  const [src, setSrc] = useState<Sources | null>(null);
  const [sizeText, setSizeText] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [checks, setChecks] = useState<Record<string, RenderCheck[]>>({});
  const canvases = useRef<Record<string, HTMLCanvasElement | null>>({});
  const v = doc.selectedVariant as Variant;
  const extras = doc.extraSizes ?? [];

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await compose.getDoc(caseId);
        if (!d) throw new Error("합성 명세가 없습니다");
        await loadFonts();
        const s = await loadComposeSources((f) => store.readBlob(caseId, f), d);
        if (alive) { setCdoc(d); setSrc(s); }
      } catch (e) {
        if (alive) setErr(errMsg(e));
      }
    })();
    return () => { alive = false; };
  }, [caseId, compose, store]);

  // 미리보기 + 점검
  useEffect(() => {
    if (!cdoc || !src) return;
    const out: Record<string, RenderCheck[]> = {};
    for (const x of extras) {
      const c = canvases.current[x.size];
      if (c) out[x.size] = renderBanner(cdoc, v, x.size, src, c);
    }
    setChecks(out);
  }, [cdoc, src, extras.map((x) => x.size).join(","), v]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (label: string, work: () => Promise<unknown>) => {
    if (!name.trim()) return setErr("위쪽 '내 이름'을 먼저 적어 주세요 (기록에 남습니다)");
    setBusy(label);
    setErr("");
    try {
      await work();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy("");
      onChanged();
    }
  };

  const saveAll = () =>
    run("save", async () => {
      if (!cdoc || !src) throw new Error("아직 준비 중입니다");
      const off = document.createElement("canvas");
      const renders: { size: string; blob: Blob }[] = [];
      const errs: string[] = [];
      for (const x of extras) {
        errs.push(...renderBanner(cdoc, v, x.size, src, off).filter((c) => c.severity === "error").map((c) => `${x.size}: ${c.message}`));
        renders.push({ size: x.size, blob: await canvasToPng(off) });
      }
      await dsvc.saveExtraRenders(caseId, renders, errs, name);
    });

  const sp = parseSizeText(suggestedSize);
  const sk = sp ? `${sp.w}x${sp.h}` : "";
  const suggestion = sk && !extras.some((x) => x.size === sk) && !(cdoc?.shared.sizes as string[] | undefined)?.includes(sk) ? sk : "";
  const unsaved = extras.filter((x) => !x.savedAt).length;
  const anyError = Object.values(checks).flat().some((c) => c.severity === "error");

  return (
    <div className="card stack small">
      <div><b>변형: 다른 매체·사이즈 추가 (시안 {v})</b></div>
      <div className="muted">
        광고주가 고른 시안의 문구·그림을 그대로 두고 사이즈에 맞춰 다시 배치합니다. 기본 3종(1080x1080, 1200x628, 320x100)은 이미 있습니다.
        특수 매체는 메모에 매체 가이드를 적어 두세요.
      </div>
      {suggestion && (
        <div className="row">
          <span>질문지 11번에 적힌 사이즈: <b>{suggestion}</b></span>
          <button className="small" disabled={!!busy} onClick={() => run("add", () => dsvc.addExtraSize(caseId, suggestion, "질문지 11번 사이즈", name))}>이 사이즈 추가</button>
        </div>
      )}
      <div className="row">
        <input type="text" placeholder="가로x세로 (예: 1080x1350)" style={{ width: 170 }} value={sizeText} onChange={(e) => setSizeText(e.target.value)} />
        <input type="text" placeholder="매체·가이드 메모 (선택)" style={{ flex: 1, minWidth: 180 }} value={note} onChange={(e) => setNote(e.target.value)} />
        <button
          disabled={!!busy || !parseSizeText(sizeText)}
          onClick={() => run("add", async () => { await dsvc.addExtraSize(caseId, sizeText, note, name); setSizeText(""); setNote(""); })}
        >
          사이즈 추가
        </button>
      </div>

      {extras.length > 0 && (
        <div className="ideas">
          {extras.map((x) => {
            const cs = checks[x.size] ?? [];
            const { w, h } = sizeOf(x.size);
            return (
              <div key={x.size} className="card stack">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <b>{x.size}</b>
                  <span className="muted">{SHAPE_LABEL[sizeShape(x.size as SizeKey)]}</span>
                </div>
                {x.note && <div className="muted">메모: {x.note}</div>}
                <canvas ref={(el) => { canvases.current[x.size] = el; }} style={{ display: "block", margin: "0 auto", maxWidth: "100%", width: w >= h ? "100%" : "auto", height: w >= h ? "auto" : 320, border: "1px solid var(--line)", background: "#fff" }} />
                {cs.map((c, i) => <div key={i} className={c.severity === "error" ? "err" : "warn"}>{c.severity === "error" ? "✗" : "⚠"} {c.message}</div>)}
                {x.savedAt ? (
                  <div className={maxKB && x.kb && x.kb > maxKB ? "warn" : "okc"}>
                    ✓ 저장됨 · {x.kb}KB{maxKB ? ` (한도 ${maxKB}KB${x.kb && x.kb > maxKB ? " 초과" : ""})` : ""}
                  </div>
                ) : <div className="warn">PNG 저장 전</div>}
                <label className="row">
                  <input type="checkbox" checked={!!x.checkedBy} disabled={!!busy || !x.savedAt} onChange={(e) => run(`chk:${x.size}`, () => dsvc.checkExtraSize(caseId, x.size, e.target.checked, name))} />
                  잘림·겹침·가독성을 확인했다{x.checkedBy ? ` (${x.checkedBy})` : ""}
                </label>
                <button className="small" disabled={!!busy} onClick={() => confirm(`${x.size} 를 지울까요?`) && run(`rm:${x.size}`, () => dsvc.removeExtraSize(caseId, x.size, name))}>지우기</button>
              </div>
            );
          })}
        </div>
      )}
      {extras.length > 0 && (
        <div className="row">
          <button className="primary" disabled={!!busy || !src || anyError} onClick={saveAll}>
            {busy === "save" ? "PNG 만드는 중…" : `추가 사이즈 PNG ${extras.length}장 저장${unsaved ? ` (저장 전 ${unsaved}장)` : ""}`}
          </button>
          {anyError && <span className="warn">✗ 표시된 문제를 해결해야 저장할 수 있습니다. 문구는 합성 단계에서만 바꿀 수 있어, 바꾸려면 내부 수정을 시작하세요.</span>}
        </div>
      )}
      <div className="muted">LLM 이미지 검수는 기본 3종에만 했습니다. 추가 사이즈는 규칙 점검과 사람 확인으로 납품합니다.</div>
      {err && <p className="err" style={{ margin: 0 }}>⚠ {err}</p>}
    </div>
  );
}
