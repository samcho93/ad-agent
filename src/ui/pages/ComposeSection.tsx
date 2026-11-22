import { useEffect, useMemo, useRef, useState } from "react";
import { ComposeService, renderFile } from "@/core/composeService";
import { SIZES, SIZE_LABEL, sceneOf, sizeLabel as sizeLabelOf, type ComposeDoc, type CopySpace, type Corner, type SizeKey, type Variant, type VariantCopy } from "@/core/compose";
import type { Issue } from "@/core/validate";
import { loadFonts } from "@/render/fonts";
import { canvasToPng, loadComposeSources, matchProductColor, productFrames, renderBanner, type RenderCheck, type Sources } from "@/render/composeCanvas";
import { DEFAULT_FX, colorIsNeutral, fxOf, fxSummary, type ProductFx, type ShadowKind } from "@/core/productFx";
import type { Box } from "@/core/compose";
import { reached, type CaseStatus } from "@/core/caseService";
import { errMsg, useApp } from "../app";
import { RevisionAssist } from "./RevisionAssist";

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
  // 미리보기에서 제품을 끌어 옮기기·크기 바꾸기
  const [frames, setFrames] = useState<Partial<Record<Variant, Box>>>({});
  const drag = useRef<{ mode: "move" | "scale"; v: Variant; px: number; py: number; dx: number; dy: number; scale: number; cx: number; cy: number; area: Box } | null>(null);

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
    // 미리보기는 바로 그린다 (끌어 옮길 때 끊기지 않게). 모든 사이즈 점검은 잠시 뒤에
    const fr: Partial<Record<Variant, Box>> = {};
    for (const v of VARIANTS) {
      const c = canvases[v].current;
      if (!c) continue;
      renderBanner(doc, v, size, src, c);
      fr[v] = productFrames.get(c)?.box;
    }
    setFrames(fr);
    const t = setTimeout(async () => {
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
  const setFx = (fn: (fx: ProductFx) => void) =>
    edit((d) => {
      if (!d.shared.product) return;
      const fx = fxOf(d.shared.product);
      fn(fx);
      d.shared.product.fx = fx;
    });
  const fx = fxOf(doc.shared.product);
  const locked = reached(status as CaseStatus, "gate2_approved");

  /** 화면 좌표 → 캔버스 픽셀 */
  const toCanvas = (v: Variant, e: React.PointerEvent) => {
    const c = canvases[v].current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height, k: c.width / r.width };
  };
  const onDown = (v: Variant) => (e: React.PointerEvent<HTMLDivElement>) => {
    const c = canvases[v].current;
    const f = c && productFrames.get(c);
    if (locked || !f || !doc.shared.product) return;
    const p = toCanvas(v, e);
    const b = f.box;
    const grip = 16 * p.k;
    const onHandle = Math.abs(p.x - (b.x + b.w)) < grip && Math.abs(p.y - (b.y + b.h)) < grip;
    if (!onHandle && (p.x < b.x || p.x > b.x + b.w || p.y < b.y || p.y > b.y + b.h)) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const pr = doc.shared.product;
    drag.current = { mode: onHandle ? "scale" : "move", v, px: p.x, py: p.y, dx: pr.dx, dy: pr.dy, scale: pr.scale, cx: b.x + b.w / 2, cy: b.y + b.h / 2, area: f.area };
  };
  const onMove = (v: Variant) => (e: React.PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g || g.v !== v) return;
    const p = toCanvas(v, e);
    const round = (n: number) => Math.round(n * 1000) / 1000;
    if (g.mode === "move") {
      edit((d) => {
        d.shared.product!.dx = round(Math.max(-1, Math.min(1, g.dx + (p.x - g.px) / g.area.w)));
        d.shared.product!.dy = round(Math.max(-1, Math.min(1, g.dy + (p.y - g.py) / g.area.h)));
      });
    } else {
      const d0 = Math.hypot(g.px - g.cx, g.py - g.cy) || 1;
      const d1 = Math.hypot(p.x - g.cx, p.y - g.cy);
      edit((d) => { d.shared.product!.scale = round(Math.max(0.1, Math.min(4, g.scale * (d1 / d0)))); });
    }
  };
  const onUp = () => { drag.current = null; };
  const autoMatch = () => {
    const c = matchProductColor(doc, size === "320x100" ? "1080x1080" : size, src);
    if (c) setFx((f) => { f.color = c; });
    else setErr("배경 색을 읽지 못했습니다");
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

  return (
    <div className="stack">
      {locked && <p className="small muted" style={{ margin: 0 }}>게이트 2를 통과해 잠겼습니다. 바꾸려면 아래 납품 단계에서 수정 요청을 기록하세요.</p>}
      <RevisionAssist caseId={caseId} doc={doc} locked={locked} onApply={(d) => { setDoc(d); setDirty(true); }} />
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
            <div style={{ position: "relative", touchAction: frames[v] && !locked ? "none" : undefined }} onPointerDown={onDown(v)} onPointerMove={onMove(v)} onPointerUp={onUp} onPointerCancel={onUp}>
              <canvas ref={canvases[v]} style={{ width: "100%", height: "auto", border: "1px solid var(--line)", background: "#fff", display: "block" }} />
              {frames[v] && !locked && canvases[v].current && (() => {
                const c = canvases[v].current!;
                const b = frames[v]!;
                const pct = (n: number, of: number) => `${(n / of) * 100}%`;
                return (
                  <div style={{ position: "absolute", left: pct(b.x, c.width), top: pct(b.y, c.height), width: pct(b.w, c.width), height: pct(b.h, c.height), outline: "1px dashed rgba(255,255,255,0.9)", boxShadow: "0 0 0 1px rgba(0,0,0,0.35)", cursor: "move", pointerEvents: "none" }}>
                    <div title="끌어서 크기 조절" style={{ position: "absolute", right: -6, bottom: -6, width: 12, height: 12, background: "#fff", border: "2px solid #b4541f", borderRadius: 2 }} />
                  </div>
                );
              })()}
            </div>
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
          <label className="row" title="글자 덩어리 뒤에 어두운(글자가 검정이면 밝은) 띠를 깝니다. 0이면 없음">
            글자 뒤 띠 <input type="range" min={0} max={0.9} step={0.05} value={doc.shared.band ?? 0} onChange={(e) => edit((d) => { d.shared.band = Number(e.target.value); })} />
            <span className="muted">{(doc.shared.band ?? 0) > 0 ? (doc.shared.band ?? 0).toFixed(2) : "없음"}</span>
          </label>
        </div>
        <div className="row">
          <span>배경 그림</span>
          <label className="row">확대 <input type="range" min={1} max={2} step={0.05} value={sceneOf(doc.shared).zoom} onChange={(e) => edit((d) => { d.shared.scene = { ...sceneOf(d.shared), zoom: Number(e.target.value) }; })} /></label>
          <label className="row" title="양수 = 그림을 위로 올림">위아래 <input type="range" min={-0.5} max={0.5} step={0.02} value={sceneOf(doc.shared).dy} onChange={(e) => edit((d) => { d.shared.scene = { ...sceneOf(d.shared), dy: Number(e.target.value) }; })} /></label>
          <label className="row" title="양수 = 그림을 왼쪽으로">좌우 <input type="range" min={-0.5} max={0.5} step={0.02} value={sceneOf(doc.shared).dx} onChange={(e) => edit((d) => { d.shared.scene = { ...sceneOf(d.shared), dx: Number(e.target.value) }; })} /></label>
          <span className="muted small">글자가 그림 속 메뉴·사람과 겹치면: 확대한 뒤 위아래로 그림을 옮기고, 글자 뒤 띠를 켜세요. (같은 비율의 그림은 확대해야 움직입니다)</span>
        </div>
        {doc.shared.product && (
          <div className="stack" style={{ gap: 6, borderTop: "1px solid var(--line)", paddingTop: 6 }}>
            <span><b>제품 누끼 합성</b> <span className="muted">— 미리보기에서 제품을 끌어 옮기고, 오른쪽 아래 점을 끌어 크기를 바꿉니다. 원본 사진 파일은 바뀌지 않고 값만 저장합니다.</span></span>
            <div className="row">
              <label className="row">크기 <input type="range" min={0.1} max={4} step={0.05} value={doc.shared.product.scale} onChange={(e) => edit((d) => { d.shared.product!.scale = Number(e.target.value); })} /></label>
              <label className="row">좌우 <input type="range" min={-1} max={1} step={0.01} value={doc.shared.product.dx} onChange={(e) => edit((d) => { d.shared.product!.dx = Number(e.target.value); })} /></label>
              <label className="row">위아래 <input type="range" min={-1} max={1} step={0.01} value={doc.shared.product.dy} onChange={(e) => edit((d) => { d.shared.product!.dy = Number(e.target.value); })} /></label>
              <label className="row">회전 <input type="range" min={-180} max={180} step={1} value={fx.rotate} onChange={(e) => setFx((f) => { f.rotate = Number(e.target.value); })} /><span className="muted">{fx.rotate}°</span></label>
              <label className="row"><input type="checkbox" checked={fx.flip} onChange={(e) => setFx((f) => { f.flip = e.target.checked; })} /> 좌우 반전</label>
            </div>
            <div className="row">
              <label className="row">그림자
                <select value={fx.shadow.kind} onChange={(e) => setFx((f) => { f.shadow.kind = e.target.value as ShadowKind; })}>
                  <option value="none">없음</option>
                  <option value="ground">바닥 그림자 (놓여 있는 느낌)</option>
                  <option value="drop">드롭 그림자 (떠 있는 느낌)</option>
                </select>
              </label>
              {fx.shadow.kind !== "none" && (
                <>
                  <label className="row" title="0 = 오른쪽, 90 = 아래, 180 = 왼쪽">방향 <input type="range" min={0} max={360} step={5} value={fx.shadow.angle} onChange={(e) => setFx((f) => { f.shadow.angle = Number(e.target.value); })} /></label>
                  <label className="row">거리 <input type="range" min={0} max={0.5} step={0.01} value={fx.shadow.distance} onChange={(e) => setFx((f) => { f.shadow.distance = Number(e.target.value); })} /></label>
                  <label className="row">흐림 <input type="range" min={0} max={0.3} step={0.01} value={fx.shadow.blur} onChange={(e) => setFx((f) => { f.shadow.blur = Number(e.target.value); })} /></label>
                  <label className="row">진하기 <input type="range" min={0} max={1} step={0.05} value={fx.shadow.opacity} onChange={(e) => setFx((f) => { f.shadow.opacity = Number(e.target.value); })} /></label>
                </>
              )}
            </div>
            <div className="row">
              <span>색</span>
              {([["brightness", "밝기"], ["contrast", "대비"], ["saturation", "채도"], ["warmth", "색온도(차갑게↔따뜻하게)"]] as const).map(([k, label]) => (
                <label key={k} className="row">{label} <input type="range" min={-100} max={100} step={1} value={fx.color[k]} onChange={(e) => setFx((f) => { f.color[k] = Number(e.target.value); })} /><span className="muted">{fx.color[k]}</span></label>
              ))}
            </div>
            <div className="row">
              <button onClick={autoMatch} title="제품이 놓인 자리의 배경 밝기·채도·색온도 쪽으로 제품 색을 절반만큼 맞춥니다">배경에 자동 맞춤</button>
              <button disabled={colorIsNeutral(fx.color)} onClick={() => setFx((f) => { f.color = { ...DEFAULT_FX.color }; })}>색 보정 되돌리기</button>
              <label className="row" title="누끼 가장자리를 안쪽으로 살짝 투명하게 해 배경에 녹아들게 합니다">가장자리 부드럽게 <input type="range" min={0} max={0.1} step={0.005} value={fx.feather} onChange={(e) => setFx((f) => { f.feather = Number(e.target.value); })} /></label>
              <button onClick={() => edit((d) => { d.shared.product = { file: d.shared.product!.file, dx: 0, dy: 0, scale: 1 }; })}>제품 합성 전부 되돌리기</button>
            </div>
            {!colorIsNeutral(fx.color) && (
              <span className="warn">제품 색을 바꿨습니다 ({fxSummary(fx)}). 실물과 달라 보이면 광고 심의·"실물과 다름" 민원 위험이 있어 검수 자료에 기록됩니다. 실물과 비교해 확인하세요.</span>
            )}
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
