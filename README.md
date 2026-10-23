# Tess

[Tess](./tutorial.md) 는 엔트리(playentry.org) 작품으로 변환되는 텍스트 프로그래밍 언어입니다.

```bash
git clone https://github.com/ddtt786/tess.git
cd tess
bun install
bun tess check examples/all_blocks.tess
bun tess run   examples/all_blocks.tess
bun tess build examples/all_blocks.tess -o blocks.ent
```

## 라이브러리

내장 라이브러리를 활용하여 직접 파싱하거나 빌드할 수 있습니다.

```js
import { parse } from "@tess/parser";

const result = parse(`
  var score = 0
  scene "main":
    object "cat":
      when key "space" up do
        forward 10
        score += 1
      end
    end
  end
`);

result.ok; // true
result.ast; // { type: 'Program', body: [...] }
result.errors; // [{ line, column, message }]
result.warnings; // [{ line, column, message }]
```

```js
import { compileProject, makeEntryBundle } from "@tess/compiler";

const result = compileProject(source, { path: "main.tess" });
if (result.ok) {
  // .ent is a gzip-compressed tar, the same format Entry saves.
  fs.writeFileSync("game.ent", await makeEntryBundle(result.project, result.assets));
}
```

## 실행기와 확장

- `bun run tessvm run <작품.ent|작품.tess>` 는 엔트리 대신 tessvm 실행기로 작품을 띄웁니다. `check`·`bench`·`emit`·`export` 도 있습니다.
- [`packages/extension`](./packages/extension/README.md) 은 playentry.org 작품 페이지의 실행기를 tessvm 으로 바꾸는 브라우저 확장입니다. 작품의 원래 블록을 그대로 실행합니다.
