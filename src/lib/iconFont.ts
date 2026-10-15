/** Font failure must not leave essential controls showing private-use replacement boxes. */
export function loadIconFont(): void {
  if (!document.fonts) return;
  const state = (value: string) => { document.documentElement.dataset.iconFont = value; };
  state("loading");
  const timer = window.setTimeout(() => state("failed"), 3000);
  void document.fonts.load('16px "Suivelle Nerd Symbols"').then((faces) => {
    window.clearTimeout(timer);
    state(faces.length ? "ready" : "failed");
  }, () => {
    window.clearTimeout(timer);
    state("failed");
  });
}
