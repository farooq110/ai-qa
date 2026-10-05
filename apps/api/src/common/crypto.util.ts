import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Field-level AES-256-GCM encryption for environment secrets (login
 * credentials). Key is derived from JWT_SECRET — the same scheme used for
 * repository connection tokens.
 */
export function encryptField(plain: string, secret: string) {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { enc: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function decryptField(record: { enc: string; iv: string; tag: string }, secret: string) {
  const key = createHash("sha256").update(secret).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(record.enc, "base64")), decipher.final()]).toString("utf8");
}
