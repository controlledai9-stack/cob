export function parseStartCommand(text: string): string | null {
  const goal = text.match(/^\s*@planner\s+start:\s*([\s\S]+)$/i)?.[1].trim();
  return goal ? goal.slice(0, 4000) : null;
}
