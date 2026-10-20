/* Two-image vision judge test. Usage: node scripts/test-vision-pair.js <ref.png> <cur.png> [model] [guided] */
const path = require("path");
const fs = require("fs");

const envPath = path.join(__dirname, "..", ".env");
for (const line of fs.readFileSync(envPath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const [, , refPath, curPath, modelArg, guidedArg] = process.argv;
const model = modelArg || process.env.OPENAI_MODEL || "gpt-4o-mini";
const guided = guidedArg === "guided";
const expectation = "The decoration on the jersey in the LAST image is flipped vertically (rotated 180 degrees) compared to the same decoration in the REFERENCE image";
const text = `Expectation: ${expectation}\nImage 1 is the REFERENCE state. The LAST image is the CURRENT state to judge.` +
  (guided ? "\nCompare carefully: locate the decoration on the sleeve in BOTH images, examine its orientation-defining features (e.g. for a flag: where is the star canton - top or bottom?) in each image, and only then decide." : "");

(async () => {
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const content = [
    { type: "text", text },
    { type: "image_url", image_url: { url: `data:image/png;base64,${fs.readFileSync(refPath).toString("base64")}` } },
    { type: "image_url", image_url: { url: `data:image/png;base64,${fs.readFileSync(curPath).toString("base64")}` } }
  ];
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 300,
      messages: [
        { role: "system", content: "You are a strict QA verifier. Judge ONLY whether the screenshot(s) satisfy the stated expectation; ignore unrelated UI details. Compare the CURRENT (last) image against REFERENCE images when provided. Reply with a single JSON object: {\"pass\": boolean, \"reason\": string}. The reason is one sentence." },
        { role: "user", content }
      ]
    })
  });
  const data = await res.json();
  console.log(`${model}${guided ? " (guided)" : ""} =>`, (data?.choices?.[0]?.message?.content ?? JSON.stringify(data).slice(0, 300)).replace(/\n/g, " "));
})();
