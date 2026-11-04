import type { Metadata } from "next";
import { UploadForm } from "./upload-form";

export const metadata: Metadata = { title: "Upload · ALRO" };

export default function UploadPage() {
  return (
    <>
      <h1>Upload</h1>
      <p className="muted">
        For sources without a live connector yet: a Slack export (.zip), WhatsApp chat exports (.txt, or the .zip an iPhone makes), emails (.eml or
        .mbox), meeting transcripts (.vtt) or a CRM export (.csv). Uploading the same file again adds nothing new.
        Your WhatsApp chats and emails stay visible only to the people in them.
      </p>
      <UploadForm />
    </>
  );
}
