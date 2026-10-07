import { ImageResponse } from "next/og";
import { site } from "@/config/site";

export const alt = site.title;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const pill = (label: string, color: string, wash: string) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "8px 18px",
      borderRadius: 999,
      border: `1.5px solid ${color}55`,
      background: wash,
      color,
      fontSize: 24
    }}
  >
    <div style={{ width: 10, height: 10, borderRadius: 10, background: color }} />
    {label}
  </div>
);

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "#0a0d0f",
          color: "#e9eeec"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 34, fontWeight: 600 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: "#35d08f" }} />
          {site.name}
        </div>
        <div style={{ display: "flex", flexDirection: "column", fontSize: 78, fontWeight: 700, lineHeight: 1.02, letterSpacing: -3 }}>
          <span>AI drafts the tests.</span>
          <span style={{ color: "#35d08f" }}>You approve what runs.</span>
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          {pill("Generated", "#c3ccc9", "#182023")}
          {pill("Pending review", "#f2b544", "#2a2111")}
          {pill("Approved", "#35d08f", "#0f2a1f")}
          {pill("Passed", "#35d08f", "#0f2a1f")}
        </div>
      </div>
    ),
    size
  );
}
