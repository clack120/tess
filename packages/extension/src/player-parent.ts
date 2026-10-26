const playerParents = new WeakMap<HTMLElement, { count: number; value: string; priority: string }>();

// Keep shared positioning until the last replacement player leaves its parent.
export function positionPlayerParent(parent: HTMLElement): () => void {
  let saved = playerParents.get(parent);
  if (!saved) {
    if (getComputedStyle(parent).position !== 'static') return () => {};
    saved = { count: 0, value: parent.style.getPropertyValue('position'), priority: parent.style.getPropertyPriority('position') };
    playerParents.set(parent, saved);
    parent.style.setProperty('position', 'relative');
  }
  saved.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--saved.count) return;
    playerParents.delete(parent);
    if (parent.style.getPropertyValue('position') !== 'relative' || parent.style.getPropertyPriority('position')) return;
    if (saved.value) parent.style.setProperty('position', saved.value, saved.priority);
    else parent.style.removeProperty('position');
  };
}
