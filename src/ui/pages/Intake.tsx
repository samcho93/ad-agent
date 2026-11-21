import { useState } from "react";
import { IntakeSchema, intakeMismatches } from "@/core/intake";
import { prefillFromDescription, type PrefillRun } from "@/llm/prefillPipeline";
import { FAKE_PROFILE_TEXT } from "@/llm/fake";
import { downloadJson, errMsg, go, useApp } from "../app";
import { QUESTIONS, OBJECTIVES, ASSET_OPTIONS, CHANNEL_OPTIONS, UNKNOWN_LABEL, PRIVACY_NOTICE, parseSizeText, type Channel } from "@/core/intake";

type Form = {
  consent: { aiNotice: boolean; privacy: boolean; portfolio: boolean };
  contact: { company: string; contactName: string; phone: string };
  a: {
    1: string; p1: string;
    2: string; u2: boolean;
    3: (typeof OBJECTIVES)[number] | null; s3: (typeof OBJECTIVES)[number] | null; u3: boolean;
    4: string; u4: boolean;
    5: { name: string; url: string }[]; u5: boolean;
    6: string; u6: boolean;
    7: { must: string; avoid: string }; u7: boolean;
    8: { likes: string; dislikes: string }; u8: boolean;
    9: boolean | null;
    10: string[]; t10: string; u10: boolean;
    11: Channel | null; al11: Channel[]; o11: string; s11: string; k11: string; u11: boolean;
  };
};

const empty: Form = {
  consent: { aiNotice: false, privacy: false, portfolio: false },
  contact: { company: "", contactName: "", phone: "" },
  a: {
    1: "", p1: "", 2: "", u2: false, 3: null, s3: null, u3: false, 4: "", u4: false,
    5: [{ name: "", url: "" }, { name: "", url: "" }, { name: "", url: "" }], u5: false,
    6: "", u6: false, 7: { must: "", avoid: "" }, u7: false, 8: { likes: "", dislikes: "" }, u8: false,
    9: null, 10: [], t10: "", u10: false, 11: null, al11: [], o11: "", s11: "", k11: "", u11: false,
  },
};

/** 문항별로 비교할 답 (AI 초안을 사람이 고쳤는지 볼 때) */
function answerKey(f: Form, no: number): string {
  const a = f.a;
  const pick: Record<number, unknown> = {
    0: f.contact.company,
    1: [a[1], a.p1],
    2: [a[2], a.u2],
    3: [a[3], a.s3, a.u3],
    4: [a[4], a.u4],
    5: [a[5], a.u5],
    6: [a[6], a.u6],
    7: [a[7], a.u7],
    8: [a[8], a.u8],
    9: a[9],
    10: [a[10], a.t10, a.u10],
    11: [a[11], a.al11, a.o11, a.u11],
  };
  return JSON.stringify(pick[no] ?? null);
}

/** AI 초안을 폼에 넣는다 (값이 있는 문항만) */
function applyPrefill(base: Form, run: PrefillRun): Form {
  const d = structuredClone(base);
  const x = run.result;
  if (x.company) d.contact.company = x.company;
  if (x.q1?.text) d.a[1] = x.q1.text;
  if (x.q1?.place) d.a.p1 = x.q1.place;
  if (x.q2) { d.a[2] = x.q2; d.a.u2 = false; }
  if (x.q3) { d.a[3] = x.q3.choice; d.a.s3 = x.q3.second; d.a.u3 = false; }
  if (x.q4) { d.a[4] = x.q4; d.a.u4 = false; }
  if (x.q5) { d.a[5] = [0, 1, 2].map((i) => x.q5![i] ?? { name: "", url: "" }); d.a.u5 = false; }
  if (x.q6) { d.a[6] = x.q6; d.a.u6 = false; }
  if (x.q7) { d.a[7] = { ...x.q7 }; d.a.u7 = false; }
  if (x.q8) { d.a[8] = { ...x.q8 }; d.a.u8 = false; }
  if (x.q9 !== undefined) d.a[9] = x.q9;
  if (x.q10) { d.a[10] = [...x.q10]; d.a.u10 = false; }
  if (x.q11) { d.a[11] = x.q11.primary; d.a.al11 = [...x.q11.also]; d.a.o11 = x.q11.other; d.a.u11 = false; }
  return d;
}

/** 광고주 모드(#/intake?mode=client): 저장소 없이 답변 파일만 내려받아 담당자에게 보낸다 */
const isClientMode = () => new URLSearchParams(location.hash.split("?")[1] ?? "").get("mode") === "client";

export default function IntakePage() {
  const { svc, generator } = useApp();
  // 질문지 전에: 사업 설명 → AI 초안 (담당자 화면에서만. 광고주 화면에는 LLM 연결이 없다)
  const [profileText, setProfileText] = useState("");
  const [prefill, setPrefill] = useState<{ run: PrefillRun; snap: Form; at: string } | null>(null);
  const [prefillBusy, setPrefillBusy] = useState(false);
  const [prefillErr, setPrefillErr] = useState("");
  const clientMode = isClientMode();
  const [done, setDone] = useState(false);
  const [f, setF] = useState<Form>(empty);
  const [step, setStep] = useState(0); // 0 = 고지·동의, 1..12 = 질문 0..11, 13 = 확인
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const total = QUESTIONS.length + 2;

  const set = (fn: (d: Form) => void) =>
    setF((prev) => {
      const d = structuredClone(prev);
      fn(d);
      return d;
    });

  const q = step >= 1 && step <= 12 ? QUESTIONS[step - 1] : null;
  const unknownKey = q ? (`u${q.no}` as keyof Form["a"]) : null;
  const isUnknown = unknownKey ? Boolean(f.a[unknownKey]) : false;

  const canNext = (): boolean => {
    if (step === 0) return f.consent.aiNotice && f.consent.privacy;
    if (!q) return true;
    if (isUnknown) return true;
    switch (q.no) {
      case 0: return Boolean(f.contact.company.trim() && f.contact.contactName.trim() && f.contact.phone.trim());
      case 1: return Boolean(f.a[1].trim());
      case 2: return Boolean(f.a[2].trim());
      case 3: return f.a[3] !== null;
      case 4: return Boolean(f.a[4].trim());
      case 9: return f.a[9] !== null;
      case 10: return f.a[10].length > 0;
      case 11:
        return f.a[11] !== null && ((f.a[11] !== "기타" && !f.a.al11.includes("기타")) || Boolean(f.a.o11.trim())) && (!f.a.s11.trim() || parseSizeText(f.a.s11) !== null) && (!f.a.k11.trim() || Number(f.a.k11) > 0);
      default: return true; // 5, 6, 7, 8은 비워 둘 수 있음
    }
  };

  const toggleUnknown = () => unknownKey && set((d) => { (d.a as Record<string, unknown>)[unknownKey] = !isUnknown; });

  const toggleIn = (key: 10, v: string) =>
    set((d) => {
      const arr = d.a[key];
      if (key === 10 && v === "없음") { d.a[10] = arr.includes("없음") ? [] : ["없음"]; return; }
      const next = arr.includes(v) ? arr.filter((x) => x !== v) : [...arr.filter((x) => x !== "없음"), v];
      d.a[key] = next;
    });

  function buildIntake() {
    const now = new Date().toISOString();
    const a = f.a;
    const body = {
      version: 1,
      submittedAt: now,
      consent: { ...f.consent, consentedAt: now, noticeVersion: PRIVACY_NOTICE.version },
      ...(prefill
        ? {
            profile: {
              text: prefill.run.text,
              model: prefill.run.model,
              filledAt: prefill.at,
              // 사람이 고치지 않은 문항만 출처를 남긴다 (고친 문항은 사람의 답, 모르겠음은 그대로 모르겠음)
              sources: Object.fromEntries(
                Object.keys(prefill.run.result.sources)
                  .map((k) => [k, prefillSource(Number(k))] as const)
                  .filter((e): e is readonly [string, "text" | "estimate"] => e[1] !== null),
              ),
            },
          }
        : {}),
      contact: f.contact,
      answers: {
        "1": { text: a[1], place: a.p1.trim(), unknown: false },
        "2": { text: a.u2 ? "" : a[2], unknown: a.u2 },
        "3": { choice: a.u3 ? null : a[3], second: a.u3 || a.s3 === a[3] ? null : a.s3, unknown: a.u3 },
        "4": { text: a.u4 ? "" : a[4], unknown: a.u4 },
        "5": { competitors: a.u5 ? [] : a[5].filter((c) => c.name.trim() || c.url.trim()), unknown: a.u5 },
        "6": { text: a.u6 ? "" : a[6], unknown: a.u6 },
        "7": { must: a.u7 ? "" : a[7].must, avoid: a.u7 ? "" : a[7].avoid, unknown: a.u7 },
        "8": { likes: a.u8 ? "" : a[8].likes, dislikes: a.u8 ? "" : a[8].dislikes, unknown: a.u8 },
        "9": { hasProduct: a[9] === true },
        "10": { assets: a.u10 ? [] : a[10], text: a.u10 ? "" : a.t10, unknown: a.u10 },
        "11": a.u11
          ? { primary: null, other: "", size: "", maxKB: null, unknown: true }
          : { primary: a[11], also: a.al11.filter((c) => c !== a[11]), other: a.o11.trim(), size: a.s11.trim(), maxKB: a.k11.trim() ? Number(a.k11) : null, unknown: false },
      },
    };
    return body;
  }

  /** 이 문항이 AI 초안에서 왔고 아직 고치지 않았으면 그 출처 */
  const prefillSource = (no: number): "text" | "estimate" | null => {
    if (!prefill) return null;
    const src = prefill.run.result.sources[String(no)];
    if (!src) return null;
    return answerKey(f, no) === answerKey(prefill.snap, no) ? src : null;
  };
  const prefillEdited = (no: number) => !!prefill?.run.result.sources[String(no)] && prefillSource(no) === null;

  async function runPrefill() {
    setPrefillBusy(true);
    setPrefillErr("");
    try {
      const run = await prefillFromDescription(generator(), profileText);
      const next = applyPrefill(f, run);
      setF(next);
      setPrefill({ run, snap: next, at: new Date().toISOString() });
      setProfileText(run.text);
    } catch (e) {
      setPrefillErr(errMsg(e));
    } finally {
      setPrefillBusy(false);
    }
  }

  /** 서로 어긋나 보이는 답 (막지 않고 확인만) */
  const mismatches = (): string[] => {
    const parsed = IntakeSchema.safeParse(buildIntake());
    return parsed.success ? intakeMismatches(parsed.data) : [];
  };

  /** 담당자: 이 PC 저장소에 케이스로 저장 */
  async function saveHere() {
    setBusy(true);
    setErr("");
    try {
      const meta = await svc.createCase(buildIntake());
      if (prefill) await svc.log(meta.id, prefill.run.log);
      go("cases", meta.id);
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  }

  /** 광고주: 답변 파일로 내려받아 담당자에게 보낸다 (서버로 보내지 않음) */
  function downloadAnswer() {
    setErr("");
    const parsed = IntakeSchema.safeParse(buildIntake());
    if (!parsed.success) return setErr("빠진 답이 있어요. 이전으로 돌아가 확인해 주세요.");
    const name = f.contact.company.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 30) || "answer";
    downloadJson(`질문지답변_${name}.json`, parsed.data);
    setDone(true);
  }

  if (done) {
    return (
      <main className="narrow stack">
        <h1>답변 파일을 저장했어요</h1>
        <p>내려받은 파일(<code>질문지답변_….json</code>)을 담당자에게 메신저나 메일로 보내 주세요.</p>
        <p className="small muted">입력하신 내용은 어디에도 전송되지 않았고, 이 파일에만 들어 있어요.</p>
      </main>
    );
  }

  return (
    <main className="narrow stack">
      <div className="progress" aria-label="진행률"><div style={{ width: `${Math.round((step / (total - 1)) * 100)}%` }} /></div>
      <p className="small muted">{step === 0 ? "시작 전 안내" : step <= 12 ? `질문 ${step} / 12` : "마지막 확인"}</p>

      {step === 0 && (
        <div className="stack">
          <h1>광고 만들기 전에 알려 드려요</h1>
          <div className="card stack small">
            <p><strong>AI 사용 안내</strong><br />답해 주신 내용으로 AI가 광고 기획서와 아이디어, 이미지 초안을 만들고, 담당자가 고르고 다듬어서 드려요. AI 결과를 그대로 내보내지 않아요.</p>
            <p>입력하신 내용과 자료는 초안을 만들기 위해 외부 AI 모델 API와 디자인 도구로 전송될 수 있어요. 담당자 이름과 연락처는 AI에게 보내지 않아요.</p>
          </div>
          <label className="card row">
            <input type="checkbox" checked={f.consent.aiNotice} onChange={(e) => set((d) => { d.consent.aiNotice = e.target.checked; })} />
            <span>위 AI 사용 안내를 읽었어요 (필수)</span>
          </label>
          <label className="card row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
            <input type="checkbox" style={{ marginTop: 4 }} checked={f.consent.privacy} onChange={(e) => set((d) => { d.consent.privacy = e.target.checked; })} />
            <span className="stack" style={{ gap: 4, flex: 1, minWidth: 0 }}>
              <span>개인정보 수집·이용에 동의해요 (필수)</span>
              <span className="small">
                {PRIVACY_NOTICE.items.map((it) => (
                  <span key={it.label} style={{ display: "block" }}><b>{it.label}</b>: {it.text}</span>
                ))}
              </span>
              {PRIVACY_NOTICE.draft && <span className="small muted">이 안내 문구는 초안이에요. 계약서와 관련 법령을 확인한 뒤 확정해요.</span>}
            </span>
          </label>
          <label className="card row">
            <input type="checkbox" checked={f.consent.portfolio} onChange={(e) => set((d) => { d.consent.portfolio = e.target.checked; })} />
            <span>완성된 광고를 포트폴리오로 써도 좋아요 (선택)</span>
          </label>
          {!clientMode && (
            <div className="card stack small">
              <b>사업 설명으로 질문지 미리 채우기 (선택)</b>
              <span className="muted">
                사업주에게 들은 내용(업종, 파는 것, 가게 위치·분위기, 손님, 고민, 하고 싶은 것)을 자유롭게 적으면 AI가 분석해 질문지 답 초안을 채웁니다.
                글에 있는 내용은 <b>사업 설명에서</b>, 글에 없어 추측한 내용은 <b>AI 추정</b>으로 표시되고, 질문을 넘기며 하나씩 확인·수정합니다.
                설명 원문은 케이스에 함께 보관되어 브리프·아이디어·이미지 프롬프트에 참고로 쓰입니다. 담당자 이름·연락처는 적지 마세요 (전화번호·이메일은 자동으로 지웁니다).
              </span>
              <textarea
                rows={6}
                placeholder="예) 망원동 주택가 골목 안 작은 카페예요. 매일 원두를 직접 볶고, 이번에 신메뉴 말차크림라떼를 냈어요. 큰길에서 한 블록 들어와 있어서 동네 사람들도 잘 몰라요…"
                value={profileText}
                onChange={(e) => setProfileText(e.target.value)}
                disabled={prefillBusy}
              />
              <div className="row">
                <button className="primary" disabled={prefillBusy || !f.consent.aiNotice || !f.consent.privacy || profileText.trim().length < 10} onClick={runPrefill}>
                  {prefillBusy ? "분석 중… (1분 안쪽)" : prefill ? "다시 분석해서 채우기" : "AI로 분석해서 질문지 채우기"}
                </button>
                {import.meta.env.MODE === "fake" && <button onClick={() => setProfileText(FAKE_PROFILE_TEXT)} disabled={prefillBusy}>예시 넣기</button>}
                {(!f.consent.aiNotice || !f.consent.privacy) && <span className="muted">위 필수 동의를 먼저 체크하세요</span>}
              </div>
              {prefillErr && <p className="err" style={{ margin: 0 }}>⚠ {prefillErr}</p>}
              {prefill && (
                <div className="stack" style={{ gap: 4 }}>
                  <span className="okc">
                    채운 문항: {Object.keys(prefill.run.result.sources).sort((a, b) => Number(a) - Number(b)).map((k) => `${k}번${prefill.run.result.sources[k] === "estimate" ? "(추정)" : ""}`).join(", ") || "없음"} · {prefill.run.model}
                  </span>
                  {prefill.run.result.notes.map((n) => <span key={n} className="muted">· {n}</span>)}
                  <span className="muted">"다음"을 눌러 문항마다 확인하세요. 담당자 이름·연락처는 직접 넣어야 합니다.</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {q && (
        <div className="stack">
          <h1>{q.title}</h1>
          {q.help && <p className="small muted">{q.help}</p>}
          {prefillSource(q.no) === "text" && <p className="small okc" style={{ margin: 0 }}>✓ AI가 사업 설명에서 채움 — 맞는지 확인하세요</p>}
          {prefillSource(q.no) === "estimate" && <p className="small warn" style={{ margin: 0 }}>⚠ AI 추정 (사업 설명에 없어 추측함) — 맞으면 그대로, 아니면 고쳐 주세요. 고치지 않으면 브리프에서도 '추정'으로 남아요</p>}
          {prefillEdited(q.no) && <p className="small muted" style={{ margin: 0 }}>AI 초안을 고쳤어요 (사람의 답으로 저장)</p>}

          {!isUnknown && q.no === 0 && (
            <div className="stack">
              <input type="text" placeholder="가게(회사) 이름" value={f.contact.company} onChange={(e) => set((d) => { d.contact.company = e.target.value; })} />
              <input type="text" placeholder="담당자 이름" value={f.contact.contactName} onChange={(e) => set((d) => { d.contact.contactName = e.target.value; })} />
              <input type="tel" placeholder="연락처" value={f.contact.phone} onChange={(e) => set((d) => { d.contact.phone = e.target.value; })} />
            </div>
          )}
          {!isUnknown && (q.no === 1 || q.no === 2 || q.no === 4 || q.no === 6) && (
            <textarea value={f.a[q.no]} onChange={(e) => set((d) => { d.a[q.no as 1 | 2 | 4 | 6] = e.target.value; })} />
          )}
          {q.no === 1 && (
            <label className="small stack" style={{ gap: 4 }}>
              가게가 있는 동네·지역과 가게 모습 (선택)
              <textarea placeholder="예) 서울 마포구 망원동 주택가 골목, 빨간 벽돌 2층 건물 1층, 큰 통유리 창" value={f.a.p1} onChange={(e) => set((d) => { d.a.p1 = e.target.value; })} />
              <span className="muted">광고 그림의 거리·건물 모습에 반영돼요. 온라인 가게라면 비워 두세요.</span>
            </label>
          )}
          {!isUnknown && q.no === 3 && (
            <div className="stack">
              <b className="small">1순위 (필수)</b>
              <div>{OBJECTIVES.map((o) => (
                <button key={o} className={`choice ${f.a[3] === o ? "on" : ""}`} onClick={() => set((d) => { d.a[3] = o; if (d.a.s3 === o) d.a.s3 = null; })}>{o}</button>
              ))}</div>
              <b className="small">2순위 (선택)</b>
              <div>{OBJECTIVES.filter((o) => o !== f.a[3]).map((o) => (
                <button key={o} className={`choice ${f.a.s3 === o ? "on" : ""}`} onClick={() => set((d) => { d.a.s3 = d.a.s3 === o ? null : o; })}>{o}</button>
              ))}</div>
            </div>
          )}
          {!isUnknown && q.no === 5 && f.a[5].map((c, i) => (
            <div key={i} className="card stack">
              <input type="text" placeholder={`업체 ${i + 1} 이름`} value={c.name} onChange={(e) => set((d) => { d.a[5][i].name = e.target.value; })} />
              <input type="text" placeholder="홈페이지·SNS 주소 (선택)" value={c.url} onChange={(e) => set((d) => { d.a[5][i].url = e.target.value; })} />
            </div>
          ))}
          {!isUnknown && q.no === 7 && (
            <div className="stack">
              <label className="small">꼭 넣을 말<textarea value={f.a[7].must} onChange={(e) => set((d) => { d.a[7].must = e.target.value; })} /></label>
              <label className="small">쓰면 안 되는 말 (쉼표로 나눠 주세요)<textarea value={f.a[7].avoid} onChange={(e) => set((d) => { d.a[7].avoid = e.target.value; })} /></label>
            </div>
          )}
          {!isUnknown && q.no === 8 && (
            <div className="stack">
              <label className="small">마음에 드는 광고 (링크나 설명)<textarea value={f.a[8].likes} onChange={(e) => set((d) => { d.a[8].likes = e.target.value; })} /></label>
              <label className="small">싫은 광고<textarea value={f.a[8].dislikes} onChange={(e) => set((d) => { d.a[8].dislikes = e.target.value; })} /></label>
            </div>
          )}
          {q.no === 9 && (
            <>
              <button className={`choice ${f.a[9] === true ? "on" : ""}`} onClick={() => set((d) => { d.a[9] = true; })}>있음</button>
              <button className={`choice ${f.a[9] === false ? "on" : ""}`} onClick={() => set((d) => { d.a[9] = false; })}>없음</button>
            </>
          )}
          {!isUnknown && q.no === 10 && (
            <>
              {ASSET_OPTIONS.map((o) => (
                <button key={o} className={`choice ${f.a[10].includes(o) ? "on" : ""}`} onClick={() => toggleIn(10, o)}>{o}</button>
              ))}
              <textarea placeholder="메모 (예: 휴대폰으로 찍은 사진 몇 장)" value={f.a.t10} onChange={(e) => set((d) => { d.a.t10 = e.target.value; })} />
            </>
          )}
          {!isUnknown && q.no === 11 && (
            <>
              <b className="small">대표 매체 (하나)</b>
              <div>{CHANNEL_OPTIONS.map((o) => (
                <button key={o} className={`choice ${f.a[11] === o ? "on" : ""}`} onClick={() => set((d) => { d.a[11] = o; d.a.al11 = d.a.al11.filter((x) => x !== o); })}>{o}</button>
              ))}</div>
              <b className="small">함께 광고할 곳 (선택, 여러 개)</b>
              <div>{CHANNEL_OPTIONS.filter((o) => o !== f.a[11]).map((o) => (
                <button key={o} className={`choice ${f.a.al11.includes(o) ? "on" : ""}`} onClick={() => set((d) => { d.a.al11 = d.a.al11.includes(o) ? d.a.al11.filter((x) => x !== o) : [...d.a.al11, o]; })}>{o}</button>
              ))}</div>
              {(f.a[11] === "기타" || f.a.al11.includes("기타")) && (
                <input type="text" placeholder="매체 이름 (예: 당근 비즈프로필, 유튜브)" value={f.a.o11} onChange={(e) => set((d) => { d.a.o11 = e.target.value; })} />
              )}
              <details className="card small">
                <summary>사이즈·용량을 알고 있다면 (선택)</summary>
                <div className="stack" style={{ marginTop: 8 }}>
                  <label className="field"><span>사이즈 (가로x세로 픽셀, 예: 1080x1350)</span>
                    <input type="text" value={f.a.s11} onChange={(e) => set((d) => { d.a.s11 = e.target.value; })} />
                  </label>
                  {f.a.s11.trim() && !parseSizeText(f.a.s11) && <span className="warn">가로x세로 숫자로 적어 주세요 (예: 1080x1350)</span>}
                  <label className="field"><span>파일 용량 한도 (KB, 예: 500)</span>
                    <input type="text" inputMode="numeric" value={f.a.k11} onChange={(e) => set((d) => { d.a.k11 = e.target.value.replace(/[^0-9.]/g, ""); })} />
                  </label>
                  <span className="muted">모르면 비워 두세요. 담당자가 매체 규정을 확인해요.</span>
                </div>
              </details>
            </>
          )}

          {q.unknownAllowed && (
            <button className={`choice ${isUnknown ? "on" : ""}`} onClick={toggleUnknown}>
              {UNKNOWN_LABEL}{q.optional ? " / 건너뛰기" : ""}
            </button>
          )}
          {isUnknown && <p className="small muted">괜찮아요. 담당자가 다른 답을 보고 채운 뒤 "추정"으로 표시해 확인받을게요.</p>}
        </div>
      )}

      {step === 13 && (
        <div className="stack">
          <h1>{clientMode ? "이대로 저장할까요?" : "이대로 케이스를 만들까요?"}</h1>
          <div className="card small stack">
            <p><strong>{f.contact.company}</strong> · {f.contact.contactName}</p>
            {QUESTIONS.slice(1).map((qq) => {
              const u = (f.a as Record<string, unknown>)[`u${qq.no}`];
              const src = u ? null : prefillSource(qq.no);
              return <p key={qq.no}><span className="muted">{qq.no}. {qq.title}</span>{src === "estimate" && <span className="warn"> [AI 추정]</span>}{src === "text" && <span className="okc"> [사업 설명에서]</span>}<br />{u ? UNKNOWN_LABEL : summary(f, qq.no)}</p>;
            })}
          </div>
          {mismatches().map((m) => <p key={m} className="card warn small">⚠ 확인해 주세요: {m}</p>)}
          {err && <p className="err">{err}</p>}
        </div>
      )}

      <div className="bottombar">
        <div className="inner" style={{ maxWidth: 520 }}>
          <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || busy}>이전</button>
          {step < 13 ? (
            <button className="primary" onClick={() => setStep((s) => s + 1)} disabled={!canNext()}>다음</button>
          ) : (
            clientMode ? (
              <button className="primary" onClick={downloadAnswer}>답변 파일 내려받기</button>
            ) : (
              <span className="row">
                <button onClick={downloadAnswer} disabled={busy}>파일로 내려받기</button>
                <button className="primary" onClick={saveHere} disabled={busy}>{busy ? "저장 중…" : "이 PC에 케이스로 저장"}</button>
              </span>
            )
          )}
        </div>
      </div>
    </main>
  );
}

function summary(f: Form, no: number): string {
  const a = f.a;
  switch (no) {
    case 1: return [a[1], a.p1.trim() ? `(동네·가게 모습: ${a.p1.trim()})` : ""].filter(Boolean).join(" ");
    case 2: return a[2];
    case 3: return [a[3] ? `1순위 ${a[3]}` : "", a.s3 ? `2순위 ${a.s3}` : ""].filter(Boolean).join(", ");
    case 4: return a[4];
    case 5: return a[5].filter((c) => c.name || c.url).map((c) => c.name || c.url).join(", ") || "(없음)";
    case 6: return a[6] || "(비움)";
    case 7: return `넣을 말: ${a[7].must || "없음"} / 안 되는 말: ${a[7].avoid || "없음"}`;
    case 8: return [a[8].likes, a[8].dislikes].filter(Boolean).join(" / ") || "(비움)";
    case 9: return a[9] === null ? "" : a[9] ? "있음" : "없음";
    case 10: return [a[10].join(", "), a.t10].filter(Boolean).join(" / ");
    case 11: return [a[11] === "기타" ? a.o11 || "기타" : a[11] ?? "", a[11] !== "기타" && a.o11 ? `(${a.o11})` : "", a.al11.length ? `· 함께: ${a.al11.join(", ")}` : "", a.s11 ? `사이즈 ${a.s11}` : "", a.k11 ? `용량 한도 ${a.k11}KB` : ""].filter(Boolean).join(" ");
    default: return "";
  }
}
