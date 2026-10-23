# tessvm for Entry

엔트리 작품 페이지(`playentry.org/project/…`)의 실행기를 tessvm 으로 바꾸는 확장입니다.

```bash
bun run build:extension                   # dist 폴더와 zip 생성
bun run watch:extension                   # 소스가 바뀔 때마다 자동 빌드
bun packages/extension/build.ts --crx      # crx 까지 함께 생성
```

| 파일                            | 쓰는 곳                                  |
| ------------------------------- | ---------------------------------------- |
| `dist/`                         | 크롬·파이어폭스 121 이상에 직접 로드     |
| `tessvm-extension.zip`          | 파이어폭스                               |
| `tessvm-extension-chrome.zip`   | **크롬 웹스토어에 올리는 파일**          |
| `tessvm-extension.crx`          | 웹스토어를 거치지 않고 직접 배포할 때    |

- 크롬: `chrome://extensions` → 개발자 모드 → **압축해제된 확장 프로그램을 로드** → `dist`
- 파이어폭스: `about:debugging#/runtime/this-firefox` → **임시 부가 기능 로드** → `dist/manifest.json` 또는 `tessvm-extension.zip`

툴바 아이콘을 눌러 켜고 끕니다.

작품 페이지의 `TessVM 디버그`를 펼치면 장면별 오브젝트와 클론을 볼 수 있습니다.
대상을 가리키면 분홍색 경계를 표시하고, 클릭하면 선택을 고정해 위치·모양·실행 스레드를 확인합니다.
`전체 경계`는 현재 장면의 모든 대상 경계를 표시합니다. 우클릭 메뉴의 `오브젝트·클론 보기`로도 열 수 있습니다.
패널을 닫거나 화면 밖으로 스크롤하면 갱신을 멈춥니다. 전체 경계는 기본적으로 꺼져 있습니다.

감시 명령은 확장·VM·공용 소스 변경을 반영하며 `Ctrl+C`로 종료합니다.
이미 로드한 코드를 적용하려면 확장 관리 화면에서 확장을 새로고침한 뒤 작품 페이지도 새로고침합니다.
