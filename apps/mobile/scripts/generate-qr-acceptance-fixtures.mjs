import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import QRCode from "qrcode";

export const PUBLIC_ACCEPTANCE_INVITE =
  "t4peer://v1/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const FIXTURES = [
  ["invalid.png", "https://example.com/not-t4"],
  ["valid.png", PUBLIC_ACCEPTANCE_INVITE],
];
const QR_OPTIONS = Object.freeze({
  type: "png",
  errorCorrectionLevel: "M",
  margin: 4,
  width: 768,
  color: { dark: "#000000ff", light: "#ffffffff" },
});

export async function generateQrAcceptanceFixtures(outputDirectory, options = {}) {
  if (Object.hasOwn(options, "invite")) throw new Error("caller-supplied invites are forbidden");
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0) throw new Error("output directory required");
  const encode = options.encode ?? ((value, qrOptions) => QRCode.toBuffer(value, qrOptions));
  await mkdir(outputDirectory, { recursive: true });
  for (const [name, value] of FIXTURES) {
    const bytes = await encode(value, QR_OPTIONS);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error("QR fixture generation failed");
    await writeFile(resolve(outputDirectory, name), bytes, { flag: "w" });
  }
  return { files: FIXTURES.map(([name]) => name) };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error("usage: node generate-qr-acceptance-fixtures.mjs <output-directory>");
    process.exitCode = 1;
  } else {
    try {
      const result = await generateQrAcceptanceFixtures(resolve(args[0]));
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "QR fixture generation failed");
      process.exitCode = 1;
    }
  }
}
