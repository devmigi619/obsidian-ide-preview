# Smart Tabs (VS Code Style) - Obsidian Plugin

## 작업 규칙
- 대화 시작 시 MCP memory를 `search_nodes`로 조회하여 현재 작업 상태 파악
- 파일 탐색/분석은 서브에이전트(Task tool)에 위임하여 메인 컨텍스트 절약
- 컨텍스트가 길어지면 선제적으로 MCP memory에 진행 상황·실패 원인·다음 단계를 저장
- 사용자가 저장 요청하지 않더라도 복잡한 디버깅 중이면 중간중간 저장할 것

## Obsidian 핵심 함정 (반복 금지)
- `openState.eState`는 `originalMethod.call()` 후 mutate됨 → 필요한 값은 호출 전에 변수로 저장
- `activeDom` 직접 조작 금지 → `explorerView.onFileOpen(null)` 사용
- 포커스 해제 → `tree.setFocusedItem(null)` 사용
- 다중선택 해제 → `tree.clearSelectedDoms()` 사용
- 북마크는 `data-path` 속성 없음 → `[data-path]` 셀렉터로 찾을 수 없음

## 아키텍처 요약
- 패치 포인트: `WorkspaceLeaf.openFile`, `setViewState`, `detach`
- 탭 상태: Empty / Preview(이탤릭, 패널당 1개) / Permanent
- 의도 판별: `eState.rename === "all"` → create, Daily Notes → create, 나머지 → browse
