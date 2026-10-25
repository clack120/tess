# Entropy

[Entropy](./tutorial.md) 는 엔트리(playentry.org) 작품으로 변환되는 텍스트 프로그래밍 언어입니다.

```bash
git clone https://github.com/clack120/tess.git
cd tess
bun install
bun entropy check examples/all_blocks.etp
bun entropy run   examples/all_blocks.etp
bun entropy build examples/all_blocks.etp -o blocks.ent
```

## Entry 호환성 확인

`build` 결과는 Entropy 확장 없이 Entry의 **불러오기 → 오프라인 작품 불러오기**로 실행할 수 있는 표준 `.ent`입니다.

```bash
# .ent → .etp → .ent 왕복과 Entry 블록 스키마를 기본 3회 검사
bun entropy check blocks.ent

# 누적 변형을 더 세게 확인하려면 1~10회로 조정
bun entropy check blocks.ent --rounds 6

# 컴파일 결과를 실제 EntryJS 실행기로 확인
bun entropy run examples/all_blocks.etp --entry
```

되돌리기 경고가 하나라도 있으면 `.ent check`는 정보 보존을 보장할 수 없다고 보고 실패합니다. 왕복 검사는 구조와 안정성을 확인하지만 작품의 모든 입력과 렌더링까지 같다는 증명은 아닙니다. 중요한 작품은 `--entry`로 실제 실행도 확인하세요.

컴파일러는 EntryJS 원 실행기의 스택 오버헤드를 고려해 재귀 순환을 경고하고, 약 1,500단계부터 실패 가능성이 매우 높음을 알려 줍니다. 실제 한계는 브라우저·기기·환경마다 다릅니다.

## 라이브러리

내장 라이브러리를 활용하여 직접 파싱하거나 빌드할 수 있습니다.

```js
import { parse } from "@entropy/parser";

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
import { compileProject, makeEntryBundle } from "@entropy/compiler";

const result = compileProject(source, { path: "main.etp" });
if (result.ok) {
  // .ent is a gzip-compressed tar, the same format Entry saves.
  fs.writeFileSync("game.ent", await makeEntryBundle(result.project, result.assets));
}
```

## 실행기와 확장

- `bun run entropy-vm run <작품.ent|작품.etp>` 는 엔트리 대신 Entropy 실행기로 작품을 띄웁니다. `check`·`bench`·`emit`·`export` 도 있습니다.
- [`packages/extension`](./packages/extension/README.md) 은 playentry.org 작품 페이지의 실행기를 Entropy로 바꾸는 브라우저 확장입니다. 작품의 원래 블록을 그대로 실행합니다.

## 라이선스

Entropy 는 [GNU AGPL v3](./LICENSE)(3.0 이후 버전)로 배포합니다.

Based on Tess by ddtt786 — https://github.com/ddtt786/tess (MIT License). Tess 에서 온 부분의 MIT 고지는 [LICENSE-TESS](./LICENSE-TESS)에 있습니다.
