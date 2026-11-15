import { createOpenAI } from "@ai-sdk/openai";
import { transcribe } from "ai";

/** Voice notes and recordings need a speech-to-text model; today that's OpenAI's. */
export const transcriptionConfigured = () => !!process.env.OPENAI_API_KEY;

/** Speech to text for a voice note or recording. Throws when no speech model is configured. */
export async function transcribeAudio(audio: Uint8Array): Promise<string> {
  if (!transcriptionConfigured()) throw new Error("Voice needs OPENAI_API_KEY (speech-to-text).");
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const { text } = await transcribe({ model: openai.transcription(process.env.ALRO_TRANSCRIBE_MODEL ?? "gpt-4o-mini-transcribe"), audio });
  return text.trim();
}

export type Transcriber = (audio: Uint8Array) => Promise<string>;
