import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "광고 시안 에이전트", description: "배너 광고 시안 제작 (1단계: 질문지·브리프·아이디어·게이트 1)" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
