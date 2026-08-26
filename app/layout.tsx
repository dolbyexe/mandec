import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: "Manufacturer's Declaration Generator",
  description:
    "Turn an xClear job report into a signed-ready Manufacturer's Declaration with full ingredient breakdowns.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU">
      <body>{children}</body>
    </html>
  );
}
