import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { compileProject, verifyEntryProject } from '@entropy/compiler';
import { decompileProject, type DecompileResult, type TarEntry } from '@entropy/decompiler';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function compileOutput(result: DecompileResult) {
  const files = new Map([...result.files, ...result.assets].map((file) => [
    path.resolve('/work', file.path), file.data,
  ]));
  const host = {
    resolve: (base: string, file: string) => path.resolve(base, file),
    isFile: (file: string) => files.has(file),
    readFile: (file: string) => files.get(file) ?? null,
    readText: (file: string) => files.has(file) ? decode(files.get(file)!) : null,
  };
  const compiled = compileProject(result.source, { path: '/work/entry.etp', host, strict: true });
  assert.deepEqual(compiled.errors, []);
  assert.ok(compiled.project);
  assert.deepEqual(verifyEntryProject(compiled.project), []);
  const entries = compiled.assets.map((asset) => ({
    name: asset.target, data: files.get(asset.source)!,
  }));
  return { project: compiled.project, entries };
}

function fixture() {
  const values = Array.from({ length: 40 }, (_, i) => `${String(i).padStart(3, '0')}${'x'.repeat(110)}`);
  const compiled = compileProject(`
var first = "000190"
list packed = [${values.map((value) => JSON.stringify(value)).join(', ')}] visible at 30 -40 size 220 160
var last_ = 7
table scores:
  columns "name", "score"
  row "A", 10
end
function shared_(n):
  return n + last_
end
scene "장면 하나":
  object "주인공":
    var local_ = 5
    ${Array.from({ length: 25 }, (_, i) => `${i ? '' : 'default '}costume 그림${i} "image.svg" size 12 24`).join('\n    ')}
    function draw_():
      costume = "그림1"
    end
    when start do
      say shared_(2)
      draw_()
    end
  end
end
scene "빈 장면":
end
scene "장면-하나":
  text "조연":
    text_content = "hello"
  end
end`);
  assert.deepEqual(compiled.errors, []);
  const project = compiled.project!;
  const local = project.variables.find((variable) => variable.object)!;
  project.variables = [local, ...project.variables.filter((variable) => variable !== local)];
  // Display names can collide even though references need distinct identifiers.
  project.objects[1]!.name = '주인공';
  const image = Buffer.from('<svg width="12" height="24" xmlns="http://www.w3.org/2000/svg"/>');
  const entries: TarEntry[] = [{ name: project.objects[0]!.sprite.pictures[0]!.fileurl, data: image }];
  return { project, entries, values };
}

test('project files separate code, data and media while preserving declaration and scene order', () => {
  const { project, entries, values } = fixture();
  const result = decompileProject(project, entries, { positions: true });
  assert.deepEqual(result.warnings, []);
  assert.match(result.source, /use "var.etp"/);
  assert.match(result.source, /use "func.etp"/);
  assert.match(result.source, /use "table.etp"/);
  assert.doesNotMatch(result.source, /^var |^function |^scene /m);
  assert.ok(result.files.every((file) => file.path.endsWith('.etp')));
  assert.ok(result.assets.every((file) => file.path.startsWith('assets/')));
  assert.equal(result.assets.length, 1, 'one shared image is written once');
  const vars = decode(result.files.find((file) => file.path === 'var.etp')!.data);
  assert.ok(vars.indexOf('var first') < vars.indexOf('use "data/packed.etp"'));
  assert.ok(vars.indexOf('use "data/packed.etp"') < vars.indexOf('var last'));
  const object = decode(result.files.find((file) => file.path === 'objects/장면_하나/주인공.etp')!.data);
  assert.match(object, /^use "주인공.assets.etp"$/m);
  assert.match(object, /^when start do$/m);
  assert.match(object, /^function draw\(\) as "draw_" order 2:$/m, 'resource-owned functions stay with their object');
  assert.doesNotMatch(object, /^costume |^default costume /m);
  const data = decode(result.files.find((file) => file.path === 'data/packed.etp')!.data);
  assert.match(data, /^list packed = \[\n/);
  assert.match(data, /\] visible at 30 -40 size 220 160/);
  const again = compileOutput(result).project;
  assert.deepEqual(again.scenes.map((scene) => scene.name), project.scenes.map((scene) => scene.name));
  assert.deepEqual(again.objects.map((object) => object.name), ['주인공', '주인공']);
  assert.deepEqual(again.variables.filter((v) => ['first', 'packed', 'last_'].includes(v.name)).map((v) => v.name), ['first', 'packed', 'last_']);
  assert.deepEqual(again.variables.find((v) => v.name === 'packed')!.array!.map((item) => item.data), values);
  assert.deepEqual(again.variables.map((v) => v.name), project.variables.map((v) => v.name));
  assert.deepEqual(again.objects[0]!.sprite.pictures.map((p) => p.name), project.objects[0]!.sprite.pictures.map((p) => p.name));
});

test('resource IDs shared by objects keep each object’s resource names and dimensions', () => {
  const { project, entries } = fixture();
  const first = project.objects[0]!;
  const second = project.objects[1]!;
  const picture = first.sprite.pictures[0]!;
  second.objectType = 'sprite';
  second.sprite.pictures = [{ ...picture, name: '다른 그림', dimension: { width: 31, height: 47 } }];
  second.selectedPictureId = picture.id;
  second.entity = { ...first.entity, regX: 15.5, regY: 23.5, width: 31, height: 47 };
  const hat = { type: 'when_run_button_click', params: [null], statements: [] };
  const change = { type: 'change_to_some_shape', params: [picture.id, null], statements: [] };
  first.script = JSON.stringify([[hat, change]]);
  second.script = JSON.stringify([[hat, change]]);
  const result = decompileProject(project, entries, { sizes: true });
  const again = compileOutput(result).project;
  assert.equal(again.objects[0]!.sprite.pictures[0]!.name, picture.name);
  assert.equal(again.objects[1]!.sprite.pictures[0]!.name, '다른 그림');
  assert.deepEqual(again.objects[1]!.sprite.pictures[0]!.dimension, { width: 31, height: 47 });
  const blocks = JSON.parse(again.objects[1]!.script);
  assert.equal(blocks[0][1].params[0].params[0], again.objects[1]!.sprite.pictures[0]!.id);
});

test('the split project reaches stable source and file paths over three round trips', () => {
  let { project, entries } = fixture();
  let previous: DecompileResult | undefined;
  for (let round = 0; round < 3; round += 1) {
    const result = decompileProject(project, entries, { positions: true });
    assert.deepEqual(result.warnings, []);
    if (previous) {
      assert.equal(result.source, previous.source);
      assert.deepEqual(result.files, previous.files);
      assert.deepEqual(result.assets, previous.assets);
    }
    previous = result;
    ({ project, entries } = compileOutput(result));
  }
});

test('inline output contains every declaration and object with no source fragments', () => {
  const { project, entries } = fixture();
  const result = decompileProject(project, entries, { inline: true });
  assert.deepEqual(result.files, []);
  assert.doesNotMatch(result.source, /^\s*use(?:object|text)? /m);
  assert.match(result.source, /^list packed = \[\n/m);
  assert.match(result.source, /^function shared\(n\) as "shared_" order 1:$/m);
  assert.equal(compileOutput(result).project.objects.length, 2);
});

test('saved sprite bounds can differ from the selected costume dimensions', () => {
  const { project, entries } = fixture();
  Object.assign(project.objects[0]!.entity, { width: 2, height: 3, regX: 1, regY: 1.5 });
  const result = decompileProject(project, entries);
  const again = compileOutput(result).project.objects[0]!;
  assert.equal(again.entity.width, 2);
  assert.equal(again.entity.height, 3);
  assert.equal(again.entity.regX, 1);
  assert.equal(again.entity.regY, 1.5);
  assert.deepEqual(again.sprite.pictures[0]!.dimension, { width: 12, height: 24 });
});
