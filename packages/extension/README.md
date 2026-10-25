# Entropy for Entry

엔트리 작품 페이지와 에디터의 실행기를 Entropy로 바꿉니다. 에디터에서는 기존 실행·일시정지·정지 버튼을 그대로 사용하며 저장 전 수정 내용과 선택한 장면을 실행합니다.

## 빌드와 설치

```bash
bun run build:extension
```

| 파일 | 용도 |
| --- | --- |
| `dist/` | Chromium·Firefox에서 압축 해제 확장으로 로드 |
| `entropy-extension-chrome.zip` | Chromium용 ZIP |
| `entropy-extension.zip` | Firefox용 ZIP |
| `entropy.user.js` | Violentmonkey·Safari Userscripts용 단일 파일 |

- Chromium: 확장 관리 화면에서 개발자 모드를 켜고 `dist/`를 압축 해제된 확장으로 불러옵니다.
- Firefox 121 이상: `about:debugging#/runtime/this-firefox`에서 `dist/manifest.json` 또는 Firefox용 ZIP을 불러옵니다.
- 유저스크립트: 유저스크립트 관리자에서 `entropy.user.js`를 설치합니다. 캐시는 기본으로 켜지며 실행 화면의 우클릭 메뉴에서 끄거나 비울 수 있습니다.

## 설정과 기능

툴바 창에서 실행기, SVG 사용, 에셋 캐시와 작품 저장값을 관리할 수 있습니다. 확장 캐시는 기본으로 꺼져 있습니다.

에디터에서 내보내는 작품 JSON이 설정된 크기 경고선을 넘으면 생략할 수 있는 기본값을 줄여 저장을 돕습니다. 그래도 너무 크면 저장이 실패할 수 있습니다.

실행 화면의 우클릭 메뉴에서 디버거를 열 수 있습니다. 장면·오브젝트·클론을 고르고 상태를 확인하거나 수정할 수 있으며, 패널은 이동하고 높이를 조절할 수 있습니다.

작품에 포커스가 있으면 확장은 Esc를 작품 입력으로 전달합니다. 유저스크립트에서는 브라우저별 전체화면 동작 차이 때문에 이 기능을 사용하지 않습니다.

개발 중 자동 빌드는 `bun run watch:extension`으로 실행합니다. 변경을 적용하려면 확장과 작품 페이지를 다시 불러오세요.
