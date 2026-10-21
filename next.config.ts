import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // unpdf/pdf.js are ESM-heavy; mammoth reads via fs — keep both external so
  // the server bundle doesn't try to inline them.
  serverExternalPackages: ["unpdf", "mammoth"],
};

export default nextConfig;
