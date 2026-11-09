import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 케이스 폴더와 스킬 파일을 서버에서 직접 읽는다.
  serverExternalPackages: [],
};

export default nextConfig;
