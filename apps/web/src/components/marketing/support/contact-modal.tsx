"use client";

import { useRef, useState } from "react";
import { ImagePlus, LifeBuoy, Loader2, X } from "lucide-react";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function ContactModal() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [email, setEmail] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "submitting" | "sent">("idle");
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  function reset() {
    setTitle("");
    setDescription("");
    setEmail("");
    setImage(null);
    setPreview(null);
    setStatus("idle");
    setError("");
  }

  function close() {
    setOpen(false);
    reset();
  }

  function pickImage(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > MAX_IMAGE_BYTES) {
      setError("Image must be under 5MB.");
      return;
    }
    setError("");
    setImage(file);
    setPreview(URL.createObjectURL(file));
  }

  async function submit() {
    setError("");
    if (!title.trim() || !description.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Title, description, and a valid email are required.");
      return;
    }
    setStatus("submitting");

    try {
      let imageUrl: string | undefined;
      if (image) {
        const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
        const presignRes = await fetch(`${apiBase}/v1/support-queries/presigned-upload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentType: image.type })
        });
        const presign = await presignRes.json();
        if (!presignRes.ok) throw new Error(presign.message ?? "Unable to prepare the image upload.");
        const uploadRes = await fetch(presign.uploadUrl, { method: "PUT", headers: { "Content-Type": image.type }, body: image });
        if (!uploadRes.ok) throw new Error("Image upload to storage failed.");
        imageUrl = presign.publicUrl;
      }

      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), description: description.trim(), email: email.trim(), imageUrl })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      setStatus("sent");
    } catch (cause) {
      setStatus("idle");
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Report an issue or ask a question"
        className="fixed bottom-6 right-6 z-40 flex cursor-pointer items-center gap-2 rounded-full border border-line-strong bg-raised pl-4 pr-1.5 py-1.5 text-dim shadow-panel hover:border-[#3b4950] hover:text-fg"
      >
        <span className="text-sm font-medium text-fg">Need help?</span>
        <span className="flex size-9 items-center justify-center rounded-full bg-approve text-approve-ink">
          <LifeBuoy size={18} />
        </span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
          <div className="mkt-panel w-full max-w-md p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-xs uppercase tracking-wide text-muted">Support</p>
                <h2 className="mt-1 text-lg font-semibold text-fg">Stuck, or found a bug?</h2>
              </div>
              <button aria-label="Close" onClick={close} className="text-dim hover:text-fg">
                <X size={18} />
              </button>
            </div>

            {status === "sent" ? (
              <div className="mt-5">
                <p className="text-sm text-dim">Got it — we&apos;ve emailed you a confirmation and will follow up soon.</p>
                <button onClick={close} className="mt-4 h-9 rounded-lg bg-approve px-3.5 text-sm font-semibold text-approve-ink">
                  Done
                </button>
              </div>
            ) : (
              <div className="mt-5 flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-sm text-dim">
                  Title
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="Can't connect my repository"
                    className="h-9 rounded-lg border border-line-strong bg-raised px-3 text-sm text-fg outline-none focus-visible:border-approve"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm text-dim">
                  What happened?
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={4}
                    placeholder="Describe the issue, where you got stuck, or the bug you hit"
                    className="resize-none rounded-lg border border-line-strong bg-raised px-3 py-2 text-sm text-fg outline-none focus-visible:border-approve"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm text-dim">
                  Your email
                  <input
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@company.com"
                    className="h-9 rounded-lg border border-line-strong bg-raised px-3 text-sm text-fg outline-none focus-visible:border-approve"
                  />
                </label>

                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => pickImage(event.target.files?.[0])}
                />
                {preview ? (
                  <div className="relative w-fit">
                    <img src={preview} alt="Attachment preview" className="h-20 rounded-lg border border-line object-cover" />
                    <button
                      aria-label="Remove image"
                      onClick={() => {
                        setImage(null);
                        setPreview(null);
                      }}
                      className="absolute -right-2 -top-2 flex size-5 items-center justify-center rounded-full bg-raised text-dim"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => fileInput.current?.click()}
                    className="flex w-fit items-center gap-2 rounded-lg border border-line-strong bg-raised px-3 py-2 text-sm text-dim hover:text-fg"
                  >
                    <ImagePlus size={15} /> Attach a screenshot
                  </button>
                )}

                {error && <p className="text-sm text-change">{error}</p>}

                <button
                  onClick={submit}
                  disabled={status === "submitting"}
                  className="mt-1 flex h-9 items-center justify-center gap-2 rounded-lg bg-approve text-sm font-semibold text-approve-ink disabled:opacity-60"
                >
                  {status === "submitting" ? <Loader2 size={15} className="animate-spin" /> : null}
                  {status === "submitting" ? "Sending…" : "Send"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
