/* One-off: sanity-check the two-image vision judge — reference + rotated current. */
const path = require("path");
const fs = require("fs");

const envPath = path.join(__dirname, "..", ".env");
for (const line of fs.readFileSync(envPath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

(async () => {
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const content = [
    { type: "text", text: "Expectation: The decoration on the jersey in the LAST image is flipped vertically (rotated 180 degrees) compared to the same decoration in the REFERENCE image\nImage 1 is the REFERENCE state. The LAST image is the CURRENT state to judge." },
    { type: "image_url", image_url: { url: `data:image/png;base64,${fs.readFileSync(process.argv[2]).toString("base64")}` } },
    { type: "image_url", image_url: { url: `data:image/png;base64,${fs.readFileSync(process.argv[3]).toString("base64")}` } }
  ];
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0,
      max_tokens: 200,
      messages: [
        { role: "system", content: "You are a strict QA verifier. Judge ONLY whether the screenshot(s) satisfy the stated expectation; ignore unrelated UI details. Compare the CURRENT (last) image against REFERENCE images when provided. Reply with a single JSON object: {\"pass\": boolean, \"reason\": string}. The reason is one sentence." },
        { role: "user", content }
      ]
    })
  });
  const data = await res.json();
  console.log(data?.choices?.[0]?.message?.content ?? JSON.stringify(data).slice(0, 300));
})();
