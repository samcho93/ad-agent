import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
// 도움말의 단일 원본은 저장소의 README.md 다 (GitHub와 앱에서 같은 내용)
import readme from "../../../README.md?raw";

/** 도움말: 이 에이전트를 어떻게 쓰고, 어떻게 구성했고, 어떻게 만들었는지 */
export function HelpPage() {
  // 우리 저장소의 파일이라 그대로 HTML 로 바꿔 넣는다 (사용자 입력이 아님)
  const html = useMemo(() => marked.parse(readme, { async: false, gfm: true }) as string, []);
  const box = useRef<HTMLDivElement>(null);
  const [toc, setToc] = useState<{ id: string; text: string }[]>([]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const items: { id: string; text: string }[] = [];
    el.querySelectorAll("h2").forEach((h, i) => {
      h.id = `help-${i}`;
      items.push({ id: h.id, text: h.textContent ?? "" });
    });
    setToc(items);
    // 바깥 주소는 새 탭으로
    el.querySelectorAll<HTMLAnchorElement>('a[href^="http"]').forEach((a) => {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    });
  }, [html]);

  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <main className="wrap help-page">
      <nav className="card small help-toc">
        <b>목차</b>
        <ol>
          {toc.map((t) => (
            <li key={t.id}>
              <a href={`#${t.id}`} onClick={(e) => { e.preventDefault(); jump(t.id); }}>{t.text}</a>
            </li>
          ))}
        </ol>
        <span className="muted">
          같은 내용: <a href="https://github.com/samcho93/ad-agent#readme" target="_blank" rel="noopener noreferrer">GitHub README</a>
        </span>
      </nav>
      <article ref={box} className="help" dangerouslySetInnerHTML={{ __html: html }} />
    </main>
  );
}
