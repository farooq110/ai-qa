import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let client: S3Client | null = null;

export function getS3() {
  const bucket = process.env.AWS_S3_BUCKET_NAME;
  const region = process.env.AWS_S3_REGION;
  if (!bucket || !region || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) return null;
  if (!client) client = new S3Client({ region });
  return { client, bucket, region };
}

export async function createPresignedUpload(contentType: string) {
  const s3 = getS3();
  if (!s3) return null;
  const extension = contentType.split("/")[1] || "bin";
  const key = `support-queries/${randomUUID()}.${extension}`;
  const uploadUrl = await getSignedUrl(s3.client, new PutObjectCommand({ Bucket: s3.bucket, Key: key, ContentType: contentType }), { expiresIn: 300 });
  const publicUrl = `https://${s3.bucket}.s3.${s3.region}.amazonaws.com/${key}`;
  return { uploadUrl, publicUrl };
}
