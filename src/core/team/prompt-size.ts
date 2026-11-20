/** A lightweight estimate for prompt-size run events. */
export function promptSize(text: string): { chars: number; approxTokens: number } {
  return { chars: text.length, approxTokens: Math.ceil(text.length / 4) };
}

export function promptSizeMessage(label: string, text: string): string {
  const { chars, approxTokens } = promptSize(text);
  return `${label} prompt: ${chars} chars (~${approxTokens} tokens)`;
}
