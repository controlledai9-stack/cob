import { useEffect, useRef, useState } from "react";
import { Mic, Square, Loader2 } from "lucide-react";
import { recordingToWav, SILENCE_LEVEL, speechLevel } from "../shared/audio";

/** The longest recording the offline voice engine accepts (60 s of 16 kHz mono). */
export const VOICE_MAX_MS = 60_000;

/**
 * Press the mic to record, press again (or wait 60 s) to stop. The recording is
 * transcribed offline by Cobble's own voice engine and handed to `onText`; it is
 * never sent on its own, so the user always sees the words first.
 */
export function useVoiceInput(
  transcribe: ((audio: ArrayBuffer) => Promise<string>) | undefined,
  onText: (text: string) => void,
) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const cancelled = useRef(false);
  const latest = useRef(onText);
  latest.current = onText;
  useEffect(
    () => () => {
      mounted.current = false;
      cancelled.current = true;
      clearTimeout(timer.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );
  const toggle = async () => {
    if (!transcribe || transcribing) return;
    if (recording) {
      recorder.current?.stop();
      return;
    }
    setError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("This window has no microphone access.");
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) {
        stream.current.getTracks().forEach((t) => t.stop());
        return;
      }
      cancelled.current = false;
      const rec = new MediaRecorder(stream.current);
      const chunks: Blob[] = [];
      recorder.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onstop = async () => {
        clearTimeout(timer.current);
        stream.current?.getTracks().forEach((t) => t.stop());
        if (!mounted.current || cancelled.current) return;
        setRecording(false);
        setTranscribing(true);
        try {
          const wav = await recordingToWav(
            await new Blob(chunks, { type: rec.mimeType }).arrayBuffer(),
          );
          if (speechLevel(wav) < SILENCE_LEVEL) {
            setError("I didn't hear any speech. Try again a little closer to the mic.");
            return;
          }
          const text = (await transcribe(wav)).replace(/\s+/g, " ").trim();
          if (!mounted.current) return;
          if (!text || /^\[(?:blank_audio|silence|music)\]$/i.test(text))
            setError("I didn't catch anything. Try again a little closer to the mic.");
          else latest.current(text);
        } catch (e) {
          if (mounted.current) setError(voiceError(e));
        } finally {
          if (mounted.current) setTranscribing(false);
        }
      };
      rec.start();
      setRecording(true);
      timer.current = setTimeout(() => {
        if (rec.state === "recording") rec.stop();
      }, VOICE_MAX_MS);
    } catch (e) {
      stream.current?.getTracks().forEach((t) => t.stop());
      setRecording(false);
      setError(voiceError(e));
    }
  };
  return { available: !!transcribe, recording, transcribing, error, toggle };
}

/** Plain reasons for the usual microphone failures. */
export function voiceError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || /permission|denied/i.test(text))
    return "Cobble can't use the microphone. Allow microphone access for apps in Windows Settings → Privacy & security → Microphone.";
  if (name === "NotFoundError" || /requested device not found/i.test(text))
    return "No microphone found. Plug one in or check Windows sound settings.";
  if (/voice files are missing/i.test(text))
    return "Cobble's offline voice engine isn't installed. Reinstall Cobble, or in a source checkout run: npm run prepare:runtime";
  return `Voice input failed: ${text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")}`;
}

export function MicButton({
  voice,
}: {
  voice: ReturnType<typeof useVoiceInput>;
}) {
  if (!voice.available) return null;
  const label = voice.transcribing
    ? "Turning your recording into text"
    : voice.recording
      ? "Stop recording"
      : "Speak your message";
  return (
    <button
      type="button"
      className={`ui-mic${voice.recording ? " recording" : ""}`}
      aria-label={label}
      title={label}
      aria-pressed={voice.recording}
      disabled={voice.transcribing}
      onClick={() => void voice.toggle()}
    >
      {voice.transcribing ? (
        <Loader2 size={18} className="ui-spin" aria-hidden="true" />
      ) : voice.recording ? (
        <Square size={16} aria-hidden="true" />
      ) : (
        <Mic size={18} aria-hidden="true" />
      )}
    </button>
  );
}
