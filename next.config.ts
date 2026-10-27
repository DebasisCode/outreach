import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // unpdf/pdf.js are ESM-heavy; mammoth reads via fs; playwright-core drives
  // the browser — keep them external so the server bundle doesn't inline them.
  serverExternalPackages: ["unpdf", "mammoth", "playwright-core"],
};

export default nextConfig;
