import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "浙江公务员考情查询系统",
  description: "浙江省全省 2024—2026 年公务员岗位、成绩与录用信息查询",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
