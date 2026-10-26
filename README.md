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

기존 작품을 편집하려면 디컴파일한 `entry.etp`부터 여세요. 전역 선언·함수·장면·오브젝트는 `use`로 연결된 별도 `.etp` 파일로 나뉩니다.

```bash
bun entropy decompile work.ent -o work
bun entropy build work/entry.etp -o edited.ent

# 이미지·소리 없이 코드만 살펴보기
bun entropy decompile work.ent -o source --no-assets
```

큰 작품을 컴파일할 때는 Entry의 기본 블록 속성을 생략해 저장 JSON이 불필요하게 커지는 것을 줄입니다. 변수·리스트 데이터와 블록 ID는 유지합니다.

```bash
# .ent → .etp → .ent 왕복과 Entry 블록 스키마를 기본 3회 검사
bun entropy check blocks.ent

# 필요하면 왕복 횟수를 1~10회로 조정
bun entropy check blocks.ent --rounds 6

# 첫 변환에서 달라진 데이터·코드·메타데이터까지 기록
bun entropy check blocks.ent --report roundtrip.json

# 컴파일 결과를 실제 EntryJS 실행기로 확인
bun entropy run examples/all_blocks.etp --entry
```

되돌리기 경고나 원본과의 차이가 있으면 왕복 검사는 실패합니다. 원본 대조와 소스 안정성은 실제 실행 동등성과 구분합니다. [런타임 함정과 진단 안내](./ENTRY-RUNTIME.md)에서 비교 범위, 제외되는 정보, 알려진 VM 차이를 확인할 수 있습니다.

## 실행기와 확장

- `bun run entropy-vm run <작품.ent|작품.etp>` 는 Entropy 실행기로 작품을 띄웁니다.
- [`packages/extension`](./packages/extension/README.md) 은 playentry.org 작품 페이지의 실행기를 Entropy로 바꾸는 브라우저 확장입니다. 작품의 원래 블록을 그대로 실행합니다.

## 라이선스

Entropy 는 [GNU AGPL v3](./LICENSE)(3.0 이후 버전)로 배포합니다.

Based on Tess by ddtt786 — https://github.com/ddtt786/tess (MIT License). Tess 에서 온 부분의 MIT 고지는 [LICENSE-TESS](./LICENSE-TESS)에 있습니다.
