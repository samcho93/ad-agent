"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { QUESTIONS, OBJECTIVES, ASSET_OPTIONS, CHANNEL_OPTIONS, UNKNOWN_LABEL } from "@/core/intake";

type Form = {
  consent: { aiNotice: boolean; privacy: boolean; portfolio: boolean };
  contact: { company: string; contactName: string; phone: string };
  a: {
    1: string;
    2: string; u2: boolean;
    3: (typeof OBJECTIVES)[number] | null; u3: boolean;
    4: string; u4: boolean;
    5: { name: string; url: string }[]; u5: boolean;
    6: string; u6: boolean;
    7: { must: string; avoid: string }; u7: boolean;
    8: { likes: string; dislikes: string }; u8: boolean;
    9: boolean | null;
    10: string[]; t10: string; u10: boolean;
    11: string[]; u11: boolean;
  };
};

const empty: Form = {
  consent: { aiNotice: false, privacy: false, portfolio: false },
  contact: { company: "", contactName: "", phone: "" },
  a: {
    1: "", 2: "", u2: false, 3: null, u3: false, 4: "", u4: false,
    5: [{ name: "", url: "" }, { name: "", url: "" }, { name: "", url: "" }], u5: false,
    6: "", u6: false, 7: { must: "", avoid: "" }, u7: false, 8: { likes: "", dislikes: "" }, u8: false,
    9: null, 10: [], t10: "", u10: false, 11: [], u11: false,
  },
};

export default function IntakePage() {
  const router = useRouter();
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
      case 11: return f.a[11].length > 0;
      default: return true; // 5, 6, 7, 8은 비워 둘 수 있음
    }
  };

  const toggleUnknown = () => unknownKey && set((d) => { (d.a as Record<string, unknown>)[unknownKey] = !isUnknown; });

  const toggleIn = (key: 10 | 11, v: string) =>
    set((d) => {
      const arr = d.a[key];
      if (key === 10 && v === "없음") { d.a[10] = arr.includes("없음") ? [] : ["없음"]; return; }
      const next = arr.includes(v) ? arr.filter((x) => x !== v) : [...arr.filter((x) => x !== "없음"), v];
      d.a[key] = next;
    });

  async function submit() {
    setBusy(true);
    setErr("");
    const now = new Date().toISOString();
    const a = f.a;
    const body = {
      version: 1,
      submittedAt: now,
      consent: { ...f.consent, consentedAt: now },
      contact: f.contact,
      answers: {
        "1": { text: a[1], unknown: false },
        "2": { text: a.u2 ? "" : a[2], unknown: a.u2 },
        "3": { choice: a.u3 ? null : a[3], unknown: a.u3 },
        "4": { text: a.u4 ? "" : a[4], unknown: a.u4 },
        "5": { competitors: a.u5 ? [] : a[5].filter((c) => c.name.trim() || c.url.trim()), unknown: a.u5 },
        "6": { text: a.u6 ? "" : a[6], unknown: a.u6 },
        "7": { must: a.u7 ? "" : a[7].must, avoid: a.u7 ? "" : a[7].avoid, unknown: a.u7 },
        "8": { likes: a.u8 ? "" : a[8].likes, dislikes: a.u8 ? "" : a[8].dislikes, unknown: a.u8 },
        "9": { hasProduct: a[9] === true },
        "10": { assets: a.u10 ? [] : a[10], text: a.u10 ? "" : a.t10, unknown: a.u10 },
        "11": { channels: a.u11 ? [] : a[11], unknown: a.u11 },
      },
    };
    try {
      const res = await fetch("/api/cases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "제출 실패");
      router.push("/intake/done");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "제출 실패");
      setBusy(false);
    }
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
          <label className="card row">
            <input type="checkbox" checked={f.consent.privacy} onChange={(e) => set((d) => { d.consent.privacy = e.target.checked; })} />
            <span>개인정보(상호, 담당자 이름, 연락처) 수집·이용에 동의해요 (필수)<br /><span className="small muted">보관 기간: 미정 (확정 후 안내)</span></span>
          </label>
          <label className="card row">
            <input type="checkbox" checked={f.consent.portfolio} onChange={(e) => set((d) => { d.consent.portfolio = e.target.checked; })} />
            <span>완성된 광고를 포트폴리오로 써도 좋아요 (선택)</span>
          </label>
        </div>
      )}

      {q && (
        <div className="stack">
          <h1>{q.title}</h1>
          {q.help && <p className="small muted">{q.help}</p>}

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
          {!isUnknown && q.no === 3 && OBJECTIVES.map((o) => (
            <button key={o} className={`choice ${f.a[3] === o ? "on" : ""}`} onClick={() => set((d) => { d.a[3] = o; })}>{o}</button>
          ))}
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
          {!isUnknown && q.no === 11 && CHANNEL_OPTIONS.map((o) => (
            <button key={o} className={`choice ${f.a[11].includes(o) ? "on" : ""}`} onClick={() => toggleIn(11, o)}>{o}</button>
          ))}

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
          <h1>이대로 보낼까요?</h1>
          <div className="card small stack">
            <p><strong>{f.contact.company}</strong> · {f.contact.contactName}</p>
            {QUESTIONS.slice(1).map((qq) => {
              const u = (f.a as Record<string, unknown>)[`u${qq.no}`];
              return <p key={qq.no}><span className="muted">{qq.no}. {qq.title}</span><br />{u ? UNKNOWN_LABEL : summary(f, qq.no)}</p>;
            })}
          </div>
          {err && <p className="err">{err}</p>}
        </div>
      )}

      <div className="bottombar">
        <div className="inner" style={{ maxWidth: 520 }}>
          <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || busy}>이전</button>
          {step < 13 ? (
            <button className="primary" onClick={() => setStep((s) => s + 1)} disabled={!canNext()}>다음</button>
          ) : (
            <button className="primary" onClick={submit} disabled={busy}>{busy ? "보내는 중…" : "보내기"}</button>
          )}
        </div>
      </div>
    </main>
  );
}

function summary(f: Form, no: number): string {
  const a = f.a;
  switch (no) {
    case 1: return a[1];
    case 2: return a[2];
    case 3: return a[3] ?? "";
    case 4: return a[4];
    case 5: return a[5].filter((c) => c.name || c.url).map((c) => c.name || c.url).join(", ") || "(없음)";
    case 6: return a[6] || "(비움)";
    case 7: return `넣을 말: ${a[7].must || "없음"} / 안 되는 말: ${a[7].avoid || "없음"}`;
    case 8: return [a[8].likes, a[8].dislikes].filter(Boolean).join(" / ") || "(비움)";
    case 9: return a[9] === null ? "" : a[9] ? "있음" : "없음";
    case 10: return [a[10].join(", "), a.t10].filter(Boolean).join(" / ");
    case 11: return a[11].join(", ");
    default: return "";
  }
}
