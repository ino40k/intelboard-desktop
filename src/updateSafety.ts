const barriers = new Set<() => Promise<void>>();
let preparing = false,
  composing = false,
  generation = 0;
export const isUpdatePreparing = () => preparing;
export function registerUpdateBarrier(barrier: () => Promise<void>) {
  barriers.add(barrier);
  return () => {
    barriers.delete(barrier);
  };
}
const frame = () =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 60);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
  });
export async function prepareForUpdate() {
  if (composing)
    throw Error("Finish composing your text before IntelBoard restarts.");
  if (document.querySelector("dialog[open]"))
    throw Error("Close the active dialog to let IntelBoard finish updating.");
  const token = ++generation;
  preparing = true;
  (document.activeElement as HTMLElement | null)?.blur();
  document.getElementById("root")!.inert = true;
  try {
    // Let active editor blur/React state commit before taking the final snapshot.
    await frame();
    await frame();
    if (token !== generation) throw Error("Update preparation was cancelled.");
    for (const barrier of barriers) {
      await barrier();
      if (token !== generation)
        throw Error("Update preparation was cancelled.");
    }
    const preferences: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      if (key.startsWith("intelboard."))
        preferences[key] = localStorage.getItem(key)!;
    }
    return preferences;
  } catch (error) {
    if (token === generation) releaseUpdatePreparation();
    throw error;
  }
}
export function releaseUpdatePreparation() {
  generation++;
  preparing = false;
  const root = document.getElementById("root");
  if (root) root.inert = false;
}
document.addEventListener(
  "compositionstart",
  () => {
    composing = true;
  },
  true,
);
document.addEventListener(
  "compositionend",
  () => {
    composing = false;
  },
  true,
);
