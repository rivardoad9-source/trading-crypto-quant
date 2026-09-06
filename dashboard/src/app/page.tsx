import { redirect } from "next/navigation";

/**
 * Main dashboard = the analytics page (docs/analytics_dashboard.html, served
 * statically at /analytics.html). The former root (Quant Command Center) moved
 * to /cmd — see commit history (6 Sep 2026, user decision).
 */
export default function Home() {
  redirect("/analytics.html");
}
