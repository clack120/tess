import type { EntropyHandle } from './boot.ts';
import { stage, type Entity, type Target, type Variable } from '../runtime/model.ts';

export interface EnvChoices {
  boost: string;
  device: string;
  touch: string;
  // Empty username and nickname mean signed out.
  userId: string;
  nickname: string;
}

interface ObjectView {
  id: string;
  name: string;
  objectType: string;
  pictures: Target['pictures'];
  rotateMethod: string;
  getPicture(value: unknown): Target['pictures'][number] | null;
  setRotateMethod(method: string): void;
}

function objectView(target: Target): ObjectView {
  return {
    id: target.id,
    name: target.name,
    objectType: target.objectType,
    pictures: target.pictures,
    rotateMethod: target.rotateMethod,
    getPicture: (value: unknown) => target.getPicture(value),
    setRotateMethod(method: string) {
      target.rotateMethod = method;
      // Non-free rotation modes report zero immediately.
      target.forEachEntity((entity) => {
        entity.setRotation(entity.rotation);
        entity.touch();
      });
    },
  };
}

function variableView(variable: Variable, redraw: () => void) {
  const seen = {
    getName: () => variable.name,
    isVisible: () => variable.visible,
    setVisible(visible: boolean) {
      variable.visible = Boolean(visible);
      redraw();
    },
  };
  if (variable.isList) {
    return {
      ...seen,
      getArray: () => variable.array,
      // Entry's list API uses one-based indices.
      replaceValue(index: number, data: string | number) {
        const item = variable.array[index - 1];
        if (item) {
          item.data = data;
          variable.touch();
        }
        redraw();
      },
      appendValue(data: string | number) {
        variable.array.push({ data });
        variable.touch();
        redraw();
      },
      deleteValue(index: number) {
        variable.array.splice(index - 1, 1);
        variable.touch();
        redraw();
      },
    };
  }
  return {
    ...seen,
    getValue: () => variable.getValue(),
    setValue(value: string | number) {
      variable.setValue(value);
      redraw();
    },
  };
}

export function makeVmRuntime(handle: EntropyHandle) {
  const { vm, renderer } = handle;
  const redraw = () => renderer.flush();
  const find = (id: string, list: boolean) =>
    vm.variables.find(
      (variable) => variable.id === id && variable.isList === list,
    ) ?? null;

  return {
    state: () => vm.state,
    run: () => handle.start(),
    pause: () => (vm.state === 'pause' ? handle.start() : handle.pause()),
    stop: () => handle.stop(),

    variable(id: string) {
      const variable = find(id, false);
      return variable ? variableView(variable, redraw) : null;
    },
    list(id: string) {
      const variable = find(id, true);
      return variable ? variableView(variable, redraw) : null;
    },
    sendSignal(id: string) {
      vm.fireEvent('when_message_cast', id);
    },

    object(objectId: string) {
      const target = vm.targetOf(objectId);
      return target ? { object: objectView(target), entity: target.entity } : null;
    },
    instances(objectId: string) {
      const target = vm.targetOf(objectId);
      if (!target) return [];
      const object = objectView(target);
      return [target.entity, ...target.clones].map((entity, instance) => ({
        object,
        entity,
        instance,
      }));
    },
    // Report current-scene objects in front-to-back draw order.
    currentObjects() {
      return vm.currentTargets().map((target) => ({
        id: target.id,
        name: target.name,
        entity: target.entity as Entity,
      }));
    },
    // Use pixel tests so transparent full-stage textures do not hide objects below.
    hitTest(entity: Entity, x: number, y: number): boolean {
      return vm.collision.touchingMouse(
        entity,
        x * stage.scale + stage.worldWidth / 2,
        -y * stage.scale + stage.worldHeight / 2,
      );
    },
    // Run the VM before sending a scene event because stopped engines drop events.
    goToScene(sceneId: string) {
      if (vm.state !== 'run') {
        handle.start();
      }
      vm.selectScene(sceneId);
      vm.fireEvent('when_scene_start');
    },
    // Draw one frame so edits appear while paused or stopped.
    requestUpdate: redraw,

    // Boost changes drawing rules, but entropy has no separate hardware boost availability state.
    realBoost: () => null,
    // Set VM environment fields directly; Entry needs wrappers around browser-reading blocks.
    patchEnvironment(env: EnvChoices) {
      vm.boost = env.boost === '' ? handle.defaultBoost : env.boost === 'true';
      vm.touch = env.touch === '' ? handle.defaultTouch : env.touch === 'true';
      vm.deviceType = (env.device === ''
        ? handle.defaultDeviceType
        : env.device) as typeof vm.deviceType;
      // Either viewer field means signed in; both empty restores the initial signed-out viewer.
      const id = env.userId.trim();
      const nickname = env.nickname.trim();
      vm.user = id || nickname
        ? { id: id || handle.defaultUser?.id || '', nickname: nickname || handle.defaultUser?.nickname || '' }
        : handle.defaultUser;
    },

    stageSize: () => ({ width: stage.width, height: stage.height }),
    stageCanvas: () => renderer.app.canvas as HTMLCanvasElement,
    layoutCanvas: () => handle.relayout(),
    // Pointer events already remeasure the canvas rect, so no cached rect needs refreshing.
    refreshRect: () => {},
  };
}
