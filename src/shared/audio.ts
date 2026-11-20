// Browser-native conversion avoids shipping a second audio-transcoding program.
export function encodeMonoWav(
  samples: Float32Array,
  rate = 16000,
): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(
      44 + i * 2,
      Math.round(value * (value < 0 ? 32768 : 32767)),
      true,
    );
  }
  return buffer;
}
/**
 * Loudness of the loudest half-second of a 16-bit mono WAV (root mean square,
 * 0 to 1). Near-silent recordings make the small speech model invent text.
 */
export function speechLevel(wav: ArrayBuffer, rate = 16000): number {
  const samples = new Int16Array(wav.slice(44));
  const window = Math.max(1, Math.floor(rate / 2));
  let loudest = 0;
  for (let start = 0; start < samples.length; start += window) {
    const end = Math.min(samples.length, start + window);
    let sum = 0;
    for (let i = start; i < end; i++) sum += (samples[i]! / 32768) ** 2;
    loudest = Math.max(loudest, Math.sqrt(sum / Math.max(1, end - start)));
  }
  return loudest;
}

/** Below this the recording counts as silence (about -46 dBFS). */
export const SILENCE_LEVEL = 0.005;

/**
 * Removes the repeated sentences the small speech model produces when it loops
 * ("the end of the day. the end of the day. ..."), keeping the first of each.
 */
export function cleanTranscript(text: string): string {
  const sentences = text
    .replace(/\[(?:blank_audio|silence|music|noise)\]|\((?:music|silence|noise)\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const sentence of sentences) {
    const key = sentence.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(sentence);
  }
  return kept.join(" ");
}

export async function recordingToWav(
  recording: ArrayBuffer,
): Promise<ArrayBuffer> {
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(recording);
    const length = Math.min(Math.ceil(audio.duration * 16000), 60 * 16000);
    if (!length) throw new Error("No audio captured");
    const offline = new OfflineAudioContext(1, length, 16000);
    const source = offline.createBufferSource();
    source.buffer = audio;
    source.connect(offline.destination);
    source.start();
    const mono = await offline.startRendering();
    return encodeMonoWav(mono.getChannelData(0));
  } finally {
    await context.close();
  }
}
