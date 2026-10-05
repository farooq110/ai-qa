/* One-off: sanity-check the vision judge's PASS path with a true expectation against captured evidence. */
const path = require("path");
const fs = require("fs");

const envPath = path.join(__dirname, "..", ".env");
for (const line of fs.readFileSync(envPath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const image = fs.readFileSync(process.argv[2]);

(async () => {
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0,
      max_tokens: 200,
      messages: [
        { role: "system", content: "You are a strict QA verifier. Judge ONLY whether the screenshot satisfies the stated expectation; ignore unrelated UI details. Reply with a single JSON object: {\"pass\": boolean, \"reason\": string}. The reason is one sentence." },
        { role: "user", content: [
          { type: "text", text: "Expectation: A flag logo decoration is visible on the jersey in this screenshot" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${image.toString("base64")}` } }
        ] }
      ]
    })
  });
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? JSON.stringify(data).slice(0, 300);
  console.log(text);
})();
