/** The shortcodes the product's own copy uses. Anything else is shown as typed. */
const EMOJI: Record<string, string> = {
  palm_tree: "🌴",
  face_with_thermometer: "🤒",
  house: "🏠",
  airplane: "✈️",
};

export function emojify(text: string): string {
  return text.replace(/:([a-z0-9_+'-]+):/g, (whole, name: string) =>
    Object.hasOwn(EMOJI, name) ? (EMOJI[name] ?? whole) : whole,
  );
}
