import type { EntropyHandle } from '../../../vm/src/web/boot.ts';

export interface ActorEditing {
  sync(): void;
  restore(): void;
}

// Use the existing actor controls without sending temporary changes through
// native commands, undo history or project saving.
export function beginActorEditing(entry: any, handle: EntropyHandle): ActorEditing | undefined {
  if (entry.readOnly || entry.objectEditable === false) return;
  const { vm } = handle;
  const targets = new Map(vm.targets.map(target => [target.id, target]));
  const methods = new Map(vm.targets.map(target => [target, target.rotateMethod]));
  const cleanup: Array<() => void> = [];
  const inputs = new Set<HTMLInputElement>();
  const buttons = new Set<HTMLElement>();
  const objects = new Set<any>();
  let restored = false;
  const editable = (object: any) => !restored && (vm.state === 'run' || vm.state === 'pause') && !object.getLock?.();
  const numeric = (object: any, input: HTMLInputElement | undefined, read: () => number, write: (value: number) => void) => {
    if (!input) return;
    if (!inputs.has(input)) {
      inputs.add(input);
      const disabled = input.disabled;
      let before = input.value;
      const focus = () => { before = input.value; };
      const blur = (event: Event) => {
        event.stopImmediatePropagation();
        (input as any)._focused = false;
        const text = input.value.trim().replace(/[°˚]$/, '');
        const value = Number(text);
        if (editable(object) && input.value !== before && text !== '' && Number.isFinite(value)) {
          write(value);
          handle.renderer.flush();
        }
        input.value = read().toFixed(1);
      };
      const key = (event: KeyboardEvent) => {
        if (event.key !== 'Enter' && event.key !== 'Escape') return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.key === 'Escape') input.value = before;
        input.blur();
      };
      input.addEventListener('focus', focus);
      // Capture before Entry's delayed onblur command can mutate the project.
      input.addEventListener('blur', blur, true);
      input.addEventListener('keydown', key, true);
      cleanup.push(() => {
        input.removeEventListener('focus', focus);
        input.removeEventListener('blur', blur, true);
        input.removeEventListener('keydown', key, true);
        input.disabled = disabled;
      });
    }
    const disabled = !editable(object);
    if (input.disabled !== disabled) input.disabled = disabled;
    if (document.activeElement !== input) {
      const value = read().toFixed(1);
      if (input.value !== value) input.value = value;
    }
  };
  const sync = () => {
    if (restored) return;
    const object = entry.playground?.object;
    const target = targets.get(object?.id);
    if (!target) return;
    objects.add(object);
    const entity = target.entity;
    const view = object.coordinateView_;
    numeric(object, view?.xInput_, () => entity.x, value => entity.setX(value));
    numeric(object, view?.yInput_, () => entity.y, value => entity.setY(value));
    numeric(object, view?.sizeInput_, () => entity.getSize(), value => {
      if (entity.getSize() > 0) entity.setSize(value);
    });
    numeric(object, object.directionInput_, () => entity.direction, value => entity.setDirection(value));
    numeric(object, object.rotateInput_, () => entity.rotation, value => entity.setRotation(value));
    object.rotateWrapper_?.classList.toggle('entryRemove', target.rotateMethod !== 'free');
    for (const [button, method] of [[object.rotateModeAView_, 'free'], [object.rotateModeBView_, 'vertical'],
      [object.rotateModeCView_, 'none']] as const) {
      if (!button) continue;
      if (!buttons.has(button)) {
        buttons.add(button);
        const click = (event: Event) => {
          event.preventDefault(); event.stopImmediatePropagation();
          if (!editable(object)) return;
          if (target.rotateMethod !== method) {
            target.rotateMethod = method;
            // Match Entry's rotation-mode change without resetting position,
            // size, heading or execution. Clones share the target's mode.
            entity.rotation = 0;
            entity.flip = false;
            target.forEachEntity(entity => { entity.setRotation(entity.rotation); entity.touch(); });
            handle.renderer.flush();
          }
          sync();
        };
        button.addEventListener('click', click, true);
        button.addEventListener('tab', click, true);
        cleanup.push(() => {
          button.removeEventListener('click', click, true);
          button.removeEventListener('tab', click, true);
        });
      }
      button.classList.toggle('selected', target.rotateMethod === method);
    }
  };
  function restore() {
    if (restored) return;
    restored = true;
    if (inputs.has(document.activeElement as HTMLInputElement)) (document.activeElement as HTMLInputElement).blur();
    for (const action of cleanup) action();
    for (const [target, method] of methods) target.rotateMethod = method;
    for (const object of objects) {
      try {
        object.updateCoordinateView?.(true);
        object.updateRotateMethodView?.();
      } catch (error) { console.warn('[entropy] 오브젝트 표시를 복원하지 못했습니다', error); }
    }
    // Called before native stop restores and enables the original controls.
  }
  try { sync(); }
  catch (error) { restore(); throw error; }
  return { sync, restore };
}
