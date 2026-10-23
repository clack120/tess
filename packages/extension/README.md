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

감시 명령은 확장·VM·공용 소스 변경을 반영하며 `Ctrl+C`로 종료합니다.
이미 로드한 코드를 적용하려면 확장 관리 화면에서 확장을 새로고침한 뒤 작품 페이지도 새로고침합니다.
