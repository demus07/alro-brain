import { transcribeAudio, transcriptionConfigured } from "@/ai/transcribe";
import { getViewer } from "@/lib/viewer";

export const maxDuration = 60;

const MAX_BYTES = 20 * 1024 * 1024;

/** Speech to text for the chat's microphone button. The audio isn't kept. */
export async function POST(request: Request) {
  await getViewer();
  if (!transcriptionConfigured()) return Response.json({ error: "Voice needs OPENAI_API_KEY (speech-to-text)." }, { status: 400 });
  const audio = new Uint8Array(await request.arrayBuffer());
  if (!audio.length || audio.length > MAX_BYTES) return Response.json({ error: "That recording is empty or too long." }, { status: 400 });
  try {
    return Response.json({ text: await transcribeAudio(audio) });
  } catch (e) {
    console.error("transcription failed", e);
    return Response.json({ error: "Couldn't transcribe that. Try again." }, { status: 502 });
  }
}
