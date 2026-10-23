// Browser extras use ordinary global names so the same project can still run on Entry.
import { bool } from './cast.ts';
import type { Variable } from './model.ts';
import type { Vm } from './engine.ts';

// Provide short aliases because Entry limits variable names to ten characters.
export const EXTRA_VARIABLES = {
  entropy: ['$ENTROPY'],
  clipboard: ['$CLIPBOARD'],
  cursor: ['$CURSOR'],
  mouseLock: ['$MOUSE_LOCK', '$M_LOCK'],
  deltaX: ['$DELTA_X'],
  deltaY: ['$DELTA_Y'],
  scrollX: ['$SCROLL_X'],
  scrollY: ['$SCROLL_Y'],
} as const;

export const SCROLL_MESSAGE = '$SCROLL';

type Slot = keyof typeof EXTRA_VARIABLES;

const WATCHED = ['clipboard', 'cursor', 'mouseLock'] as const;

// Accept cursor keywords only so project data cannot introduce CSS URLs or other syntax.
export const CURSORS = new Set([
  'auto', 'default', 'none', 'context-menu', 'help', 'pointer', 'progress',
  'wait', 'cell', 'crosshair', 'text', 'vertical-text', 'alias', 'copy', 'move',
  'no-drop', 'not-allowed', 'grab', 'grabbing', 'all-scroll', 'col-resize',
  'row-resize', 'n-resize', 'e-resize', 's-resize', 'w-resize', 'ne-resize',
  'nw-resize', 'se-resize', 'sw-resize', 'ew-resize', 'ns-resize',
  'nesw-resize', 'nwse-resize', 'zoom-in', 'zoom-out',
]);

export interface ExtrasHost {
  copy(text: string): void;
  cursor(value: string): void;
  lock(on: boolean): void;
  // Release page resources when the work stops.
  release(): void;
}

export interface ExtrasUse {
  clipboard: boolean;
  cursor: boolean;
  mouseLock: boolean;
  scroll: boolean;
}

export class Extras {
  host: ExtrasHost | null = null;
  readonly uses: ExtrasUse = {
    clipboard: false,
    cursor: false,
    mouseLock: false,
    scroll: false,
  };

  private readonly vm: Vm;
  private readonly slots = new Map<Slot, Variable>();
  private scrollId: string | null = null;
  private readonly dirty = new Set<Slot>();
  private moveX = 0;
  private moveY = 0;
  private wheelX = 0;
  private wheelY = 0;
  private wheeled = false;
  private locked = false;

  constructor(vm: Vm) {
    this.vm = vm;
  }

  bind(): void {
    this.slots.clear();
    for (const [slot, names] of Object.entries(EXTRA_VARIABLES) as Array<
      [Slot, readonly string[]]
    >) {
      const found = this.vm.variables.find(
        (variable) =>
          !variable.isList && variable.objectId === null && names.includes(variable.name),
      );
      if (found) {
        this.slots.set(slot, found);
      }
    }
    this.scrollId =
      this.vm.messages.find((message) => message.name === SCROLL_MESSAGE)?.id ?? null;
    this.uses.clipboard = this.slots.has('clipboard');
    this.uses.cursor = this.slots.has('cursor');
    this.uses.mouseLock = this.slots.has('mouseLock');
    this.uses.scroll = this.scrollId !== null || this.slots.has('scrollX') || this.slots.has('scrollY');
    // Act on every write, even when a repeated clipboard value is unchanged.
    for (const slot of WATCHED) {
      const variable = this.slots.get(slot);
      if (variable) {
        variable.onWrite = () => this.dirty.add(slot);
      }
    }
    // Set the runner flag before taking the snapshot so stopping does not clear it.
    this.slots.get('entropy')?.setValue(1);
    this.dirty.clear();
  }

  // Treat initial values as the baseline rather than work-triggered writes.
  started(): void {
    this.locked = false;
    this.moveX = 0;
    this.moveY = 0;
    this.wheelX = 0;
    this.wheelY = 0;
    this.wheeled = false;
    this.dirty.clear();
  }

  stopped(): void {
    this.locked = false;
    this.host?.release();
  }

  frame(): void {
    this.pushWheel();
    this.pushMove();
    for (const slot of WATCHED) {
      this.read(slot);
    }
  }

  // A viewer paste is input, not a clipboard write requested by the work.
  pasted(text: string): void {
    const slot = this.slots.get('clipboard');
    if (!slot || this.vm.state !== 'run') {
      return;
    }
    slot.setValue(text);
    // Do not copy host-provided clipboard text back to the browser.
    this.dirty.delete('clipboard');
  }

  moved(x: number, y: number): void {
    this.moveX += x;
    this.moveY += y;
  }

  // Raise one scroll signal for each frame containing wheel movement.
  scrolled(x: number, y: number): void {
    if (this.vm.state !== 'run') {
      return;
    }
    this.wheelX += x;
    this.wheelY += y;
    this.wheeled = true;
  }

  lockChanged(on: boolean): void {
    this.locked = on;
    const slot = this.slots.get('mouseLock');
    if (slot) {
      slot.setValue(on ? 1 : 0);
      this.dirty.delete('mouseLock');
    }
    if (!on) {
      this.moveX = 0;
      this.moveY = 0;
      this.writeMove();
    }
  }

  private read(slot: (typeof WATCHED)[number]): void {
    const variable = this.slots.get(slot);
    if (!variable || !this.dirty.delete(slot)) {
      return;
    }
    const value = String(variable.getValue());
    if (slot === 'clipboard') {
      this.host?.copy(value);
    } else if (slot === 'cursor') {
      const keyword = value.trim().toLowerCase();
      this.host?.cursor(CURSORS.has(keyword) ? keyword : '');
    } else {
      this.host?.lock(bool(value));
    }
  }

  private pushMove(): void {
    if (this.locked) {
      this.writeMove();
    }
  }

  private writeMove(): void {
    this.slots.get('deltaX')?.setValue(this.moveX);
    this.slots.get('deltaY')?.setValue(this.moveY);
    this.moveX = 0;
    this.moveY = 0;
  }

  private pushWheel(): void {
    if (!this.wheeled) {
      return;
    }
    this.wheeled = false;
    this.slots.get('scrollX')?.setValue(this.wheelX);
    this.slots.get('scrollY')?.setValue(this.wheelY);
    this.wheelX = 0;
    this.wheelY = 0;
    if (this.scrollId) {
      this.vm.queueMessage(this.scrollId);
    }
  }
}
