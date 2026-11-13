import { useEffect, useMemo, useRef, useState } from "react";
import { ComposeService, renderFile } from "@/core/composeService";
import { SIZES, SIZE_LABEL, sizeLabel as sizeLabelOf, type ComposeDoc, type CopySpace, type Corner, type SizeKey, type Variant, type VariantCopy } from "@/core/compose";
import type { Issue } from "@/core/validate";
import { loadFonts } from "@/render/fonts";
import { canvasToPng, loadComposeSources, renderBanner, type RenderCheck, type Sources } from "@/render/composeCanvas";
import { reached, type CaseStatus } from "@/core/caseService";
import { errMsg, useApp } from "../app";

const VARIANTS: Variant[] = ["A", "B"];

export function ComposeSection({ caseId, name, status, onChanged }: { caseId: string; name: string; status: string; onChanged: () => void }) {
  const { svc, store } = useApp();
  const compose = useMemo(() => new ComposeService(svc), [svc]);
  const [doc, setDoc] = useState<ComposeDoc | null>(null);
  const [dirty, setDirty] = useState(false);
  const [src, setSrc] = useState<Sources | null>(null);
  const [size, setSize] = useState<SizeKey>("1080x1080");
  const [checks, setChecks] = useState<RenderCheck[]>([]);
  const [copyIssues, setCopyIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState<Record<string, string>>({});
  const canvases = { A: useRef<HTMLCanvasElement>(null), B: useRef<HTMLCanvasElement>(null) };

  // 처음: 명세, 이미지, 폰트
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await compose.ensureDoc(caseId, name || "?");
        await loadFonts();
        const s = await loadComposeSources((f) => store.readBlob(caseId, f), d);
        if (!alive) return;
        setSrc(s);
        setDoc(d);
      } catch (e) {
        if (alive) setErr(errMsg(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [caseId, compose, store]); // eslint-disable-line react-hooks/exhaustive-deps

  // 저장된 PNG 미리보기·내려받기 주소
  useEffect(() => {
    if (!reached(status as CaseStatus, "compose_done")) return setSaved({});
    let alive = true;
    const made: string[] = [];
    (async () => {
      const out: Record<string, string> = {};
      for (const v of VARIANTS) for (const s of SIZES) {
        const b = await store.readBlob(caseId, renderFile(v, s));
        if (b) {
          out[`${v}_${s}`] = URL.createObjectURL(b);
          made.push(out[`${v}_${s}`]);
        }
      }
      if (alive) setSaved(out);
    })();
    return () => {
      alive = false;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [status, caseId, store]);

  // 미리보기 + 모든 사이즈 점검
  useEffect(() => {
    if (!doc || !src) return;
    const t = setTimeout(async () => {
      for (const v of VARIANTS) if (canvases[v].current) renderBanner(doc, v, size, src, canvases[v].current!);
      const off = document.createElement("canvas");
      const all: RenderCheck[] = [];
      for (const v of VARIANTS) for (const s of doc.shared.sizes) all.push(...renderBanner(doc, v, s, src, off));
      setChecks(all);
      setCopyIssues(await compose.copyIssues(caseId, doc));
    }, 120);
    return () => clearTimeout(t);
  }, [doc, src, size, caseId, compose]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err && !doc) return <p className="err">⚠ {err}</p>;
  if (!doc || !src) return <p className="muted">합성 준비 중… (Pretendard 폰트를 처음 한 번 받습니다)</p>;

  const edit = (fn: (d: ComposeDoc) => void) => {
    const d = structuredClone(doc);
    fn(d);
    setDoc(d);
    setDirty(true);
  };
  const setCopy = (v: Variant, patch: Partial<VariantCopy>) => edit((d) => Object.assign(d.variants[v], patch));
  const errors = [...checks.filter((c) => c.severity === "error"), ...copyIssues.filter((i) => i.severity === "error")];
  const warnings = [...checks.filter((c) => c.severity === "warning"), ...copyIssues.filter((i) => i.severity === "warning")];

  const run = async (label: string, work: () => Promise<unknown>) => {
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
  const needName = () => {
    if (!name.trim()) {
      setErr("이미지 단계 맨 위 '작업자 이름' 칸에 이름을 먼저 적어 주세요");
      return true;
    }
    return false;
  };

  const saveDoc = () => run("save", async () => {
    setDoc(await compose.update(caseId, doc, name));
    setDirty(false);
  });

  const saveRenders = () =>
    run("render", async () => {
      const d = await compose.update(caseId, doc, name);
      setDirty(false);
      const off = document.createElement("canvas");
      const renders: { variant: Variant; size: SizeKey; blob: Blob }[] = [];
      const errs: string[] = [];
      for (const v of VARIANTS) for (const s of d.shared.sizes) {
        errs.push(...renderBanner(d, v, s, src, off).filter((c) => c.severity === "error").map((c) => `시안 ${v} ${s}: ${c.message}`));
        renders.push({ variant: v, size: s, blob: await canvasToPng(off) });
      }
      await compose.saveRenders(caseId, renders, errs, name);
    });

  const checkLabel = (c: RenderCheck) => `${c.variant} · ${sizeLabelOf(c.size)}`;
  const locked = reached(status as CaseStatus, "gate2_approved");

  return (
    <div className="stack">
      {locked && <p className="small muted" style={{ margin: 0 }}>게이트 2를 통과해 잠겼습니다. 바꾸려면 아래 납품 단계에서 수정 요청을 기록하세요.</p>}
      <div className="row small">
        {SIZES.map((s) => (
          <button key={s} className={size === s ? "primary" : ""} onClick={() => setSize(s)}>{SIZE_LABEL[s]}</button>
        ))}
        <span className="muted">A/B는 그림·배치가 같고 메시지·버튼 문구·버튼 색만 다릅니다.</span>
      </div>

      <div className="ideas" style={{ gridTemplateColumns: size === "320x100" ? "1fr" : undefined }}>
        {VARIANTS.map((v) => (
          <div key={v} className="card stack small">
            <b>시안 {v}</b>
            <canvas ref={canvases[v]} style={{ width: "100%", height: "auto", border: "1px solid var(--line)", background: "#fff" }} />
            {checks.filter((c) => c.variant === v && c.size === size).map((c, i) => (
              <div key={i} className={c.severity === "error" ? "err" : "warn"}>⚠ {c.message}</div>
            ))}
          </div>
        ))}
      </div>

      <fieldset disabled={locked} className="plain stack">
      <div className="ideas">
        {VARIANTS.map((v) => {
          const c = doc.variants[v];
          return (
            <div key={v} className="card stack small">
              <b>시안 {v} 문구</b>
              <label className="field"><span>리드 문구 (헤드라인 위 작은 한 줄, 선택 · 띠 배너 제외)</span><input type="text" placeholder="예: 복잡한 설거지 대신" value={c.lead ?? ""} onChange={(e) => setCopy(v, { lead: e.target.value })} /></label>
              <label className="field"><span>헤드라인 — <b>엔터로 줄바꿈</b>하면 뜻 단위로 끊을 수 있어요</span><textarea style={{ minHeight: 60 }} value={c.headline} onChange={(e) => setCopy(v, { headline: e.target.value })} /></label>
              <label className="field"><span>서브카피 (띠 배너에는 들어가지 않음)</span><input type="text" value={c.sub} onChange={(e) => setCopy(v, { sub: e.target.value })} /></label>
              <label className="field"><span>버튼 문구</span><input type="text" value={c.cta} onChange={(e) => setCopy(v, { cta: e.target.value })} /></label>
              <div className="row">
                <label className="row">버튼 색 <input type="color" value={c.buttonBg} onChange={(e) => setCopy(v, { buttonBg: e.target.value })} /></label>
                <label className="row">버튼 글자 <input type="color" value={c.buttonFg} onChange={(e) => setCopy(v, { buttonFg: e.target.value })} /></label>
                <label className="row"><input type="checkbox" checked={!!c.ctaArrow} onChange={(e) => setCopy(v, { ctaArrow: e.target.checked })} /> 버튼 화살표 ›</label>
              </div>
              <div className="row">
                <label className="row"><input type="checkbox" checked={!!c.subColor} onChange={(e) => setCopy(v, { subColor: e.target.checked ? c.buttonBg : undefined })} /> 서브카피 색 따로</label>
                {c.subColor && <input type="color" value={c.subColor} onChange={(e) => setCopy(v, { subColor: e.target.value })} />}
              </div>
            </div>
          );
        })}
      </div>

      <p className="small muted" style={{ margin: 0 }}>
        🎨 {doc.colorSource?.reason ?? "버튼 색은 처음 합성을 만들 때 정한 값입니다."} 색과 톤을 바꾸는 판단은 사람이 합니다.
      </p>

      <div className="card stack small">
        <b>A/B 공통 (그림·배치)</b>
        <div className="row">
          <label className="row">문구 위치
            <select value={doc.shared.copySpace} onChange={(e) => edit((d) => { d.shared.copySpace = e.target.value as CopySpace; })}>
              {(["위", "아래", "왼쪽", "오른쪽"] as const).map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label className="row">글자 색
            <select value={doc.shared.textColor} onChange={(e) => edit((d) => { d.shared.textColor = e.target.value as ComposeDoc["shared"]["textColor"]; })}>
              <option value="#ffffff">흰색 (어두운 그라데이션)</option>
              <option value="#1f1d1a">검정 (밝은 그라데이션)</option>
            </select>
          </label>
          <label className="row">그라데이션 <input type="range" min={0} max={0.9} step={0.05} value={doc.shared.overlay} onChange={(e) => edit((d) => { d.shared.overlay = Number(e.target.value); })} /></label>
        </div>
        {doc.shared.product && (
          <div className="row">
            <span>제품 누끼</span>
            <label className="row">크기 <input type="range" min={0.3} max={1.6} step={0.05} value={doc.shared.product.scale} onChange={(e) => edit((d) => { d.shared.product!.scale = Number(e.target.value); })} /></label>
            <label className="row">좌우 <input type="range" min={-0.5} max={0.5} step={0.02} value={doc.shared.product.dx} onChange={(e) => edit((d) => { d.shared.product!.dx = Number(e.target.value); })} /></label>
            <label className="row">위아래 <input type="range" min={-0.5} max={0.5} step={0.02} value={doc.shared.product.dy} onChange={(e) => edit((d) => { d.shared.product!.dy = Number(e.target.value); })} /></label>
          </div>
        )}
        {doc.shared.logo ? (
          <div className="row">
            <span>로고 (원본 파일)</span>
            <select value={doc.shared.logo.corner} onChange={(e) => edit((d) => { d.shared.logo!.corner = e.target.value as Corner; })}>
              <option value="tl">왼쪽 위</option><option value="tr">오른쪽 위</option><option value="bl">왼쪽 아래</option><option value="br">오른쪽 아래</option>
            </select>
            <label className="row">크기 <input type="range" min={0.5} max={2} step={0.05} value={doc.shared.logo.scale} onChange={(e) => edit((d) => { d.shared.logo!.scale = Number(e.target.value); })} /></label>
          </div>
        ) : (
          <div className="warn">로고 파일이 없습니다. 이미지 단계 '자료'에 로고를 올리면 원본 그대로 얹습니다.</div>
        )}
      </div>

      <div className="card stack small">
        <b>점검 (시안 A/B × 사이즈 3종)</b>
        <span className="muted">점검 범위: 문구 잘림·넘침, 겹침, 금지어·근거 없는 숫자, 버튼 대비. 제품·문구 균형, 색, 배치 같은 디자인 판단은 사람이 합니다.</span>
        {errors.length === 0 && warnings.length === 0 && <div className="okc">✓ 규칙 점검 통과 — 디자인 마무리는 사람이 확인하세요</div>}
        {checks.filter((c) => c.severity === "error").map((c, i) => <div key={`e${i}`} className="err">✗ {checkLabel(c)}: {c.message}</div>)}
        {copyIssues.filter((i) => i.severity === "error").map((c, i) => <div key={`ce${i}`} className="err">✗ {c.where}: {c.message}</div>)}
        {checks.filter((c) => c.severity === "warning").map((c, i) => <div key={`w${i}`} className="warn">⚠ {checkLabel(c)}: {c.message}</div>)}
        {copyIssues.filter((i) => i.severity === "warning").map((c, i) => <div key={`cw${i}`} className="warn">⚠ {c.where}: {c.message}</div>)}
        <div className="row">
          <button disabled={!!busy || !dirty} onClick={() => !needName() && saveDoc()}>{busy === "save" ? "저장 중…" : dirty ? "변경 저장" : "저장됨"}</button>
          <button className="primary" disabled={!!busy || errors.length > 0} onClick={() => !needName() && saveRenders()}>
            {busy === "render" ? "PNG 만드는 중…" : `PNG ${doc.shared.sizes.length * 2}장 저장 (합성 완료)`}
          </button>
        </div>
        {errors.length > 0 && (
          <p className="warn" style={{ margin: 0 }}>
            위 ✗ 항목 {errors.length}개를 해결해야 PNG를 저장할 수 있습니다. 사이즈 탭을 바꿔 해당 시안을 확인하세요 (문구 잘림은 문구를 줄이면 풀립니다).
          </p>
        )}
        {err && <p className="err" style={{ margin: 0 }}>⚠ {err}</p>}
      </div>
      </fieldset>

      {reached(status as CaseStatus, "compose_done") && Object.keys(saved).length > 0 && (
        <div className="card stack small">
          <b>저장된 시안 (05_compose/)</b>
          <div className="row" style={{ alignItems: "flex-start" }}>
            {VARIANTS.flatMap((v) => SIZES.map((s) => (
              saved[`${v}_${s}`] && (
                <a key={`${v}_${s}`} href={saved[`${v}_${s}`]} download={`시안${v}_${s}.png`} className="card" style={{ padding: 6, width: s === "320x100" ? 220 : 150, textDecoration: "none" }}>
                  <img src={saved[`${v}_${s}`]} alt={`${v} ${s}`} style={{ width: "100%" }} />
                  <div className="muted">{v} · {s} ↓</div>
                </a>
              )
            )))}
          </div>
        </div>
      )}
    </div>
  );
}
