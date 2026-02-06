# Smart Tabs (VS Code Style) - Obsidian Plugin

## 작업 규칙
- 대화 시작 시 MCP memory를 `read_graph`로 조회하여 현재 작업 상태 파악
- 파일 탐색/분석은 서브에이전트(Task tool)에 위임하여 메인 컨텍스트 절약
- 컨텍스트가 길어지면 선제적으로 MCP memory에 진행 상황·실패 원인·다음 단계를 저장
- 사용자가 저장 요청하지 않더라도 복잡한 디버깅 중이면 중간중간 문서 및 메모리 알아서 저장할 것

## 문서 구조
프로젝트 이해를 위해 다음 문서들을 참고하세요:

- **`docs/SPEC.md`**: 기능 명세서
  - 각 기능의 동작을 객관적으로 기술 ("입력 → 출력" 형식)
  - 패턴별 규칙 (Browse/Open/Create/Promote)
  - 기능별 상세 동작

- **`docs/TEST_CHECKLIST.txt`**: 최종 테스트 체크리스트
  - 4단계 테스트 진행 순서 (기능 테스트 → 버그 수정 → 리팩토링 → 문서화)
  - 기능별 체크리스트 (87개 항목)
  - 알려진 버그 목록 및 해결 방안
  - 텍스트 파일로 편집 편의성 확보

- **`docs/NOTES.md`**: Obsidian API 레퍼런스
  - Obsidian 내부 API (WorkspaceLeaf, tree, explorerView 등)
  - 핵심 발견 사항 (explorerView.activeDom vs tree.activeDom)
  - 개발 기술 노트에 충실, API 레퍼런스와 발견만
