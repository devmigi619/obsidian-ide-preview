# IDE-style Preview Plugin - 동작 명세서

## 개요
VS Code 스타일의 Preview 탭 동작을 Obsidian에 구현한 플러그인입니다.

### 핵심 개념
| 탭 상태 | 설명 | 시각적 표시 |
|---|---|---|
| **Empty** | 빈 탭 (아무것도 열리지 않음) | - |
| **Preview** | 임시 탭, 다른 파일 열면 재사용됨 | 탭 제목 *이탤릭* |
| **Permanent** | 일반 탭, 명시적으로 닫기 전까지 유지 | 탭 제목 일반 |

### 동작 원칙
1. **탐색은 Preview**: 파일을 둘러볼 때는 탭이 쌓이지 않음
2. **의도가 명확하면 Permanent**: 더블클릭, 편집, 생성 등
3. **패널당 Preview 1개**: 같은 패널 내에서 Preview 탭은 재사용됨
4. **Permanent 보존**: Permanent 탭에서 다른 파일 열면 새 탭에서 열림

---
## 1. 표준 탐색 동작
다음 기능들은 모두 동일한 탐색 동작을 따릅니다.

**적용 대상:**
- 파일 탐색기 싱글 클릭
- Quick Switcher (Ctrl+O)
- 북마크 클릭
- 검색 결과 클릭
- 그래프 뷰 열기 / 노드 클릭
- 위키링크 클릭
- Backlinks / Outgoing Links 패널 클릭
- 최근 파일 / 무작위 노트
- Canvas / PDF 열기

**동작 규칙:**

| 현재 탭 | 동작 |
|---|---|
| Empty | 해당 탭에 **Preview**로 열기 |
| Permanent | 기존 Preview 탭 재사용, 없으면 새 Preview 탭 생성 |
| Preview | 해당 탭에서 **Preview**로 교체 |

> **참고**: "이미 열린 파일"을 클릭하면 기존 탭으로 포커스 이동 (중복 열기 방지)

---
## 2. 테스트 체크리스트
각 기능별 테스트 시 확인할 항목입니다.

### 2.1 파일 탐색기 (File Explorer)
- [ ] 싱글 클릭 → 표준 탐색 동작
- [ ] 더블 클릭 → Permanent로 열기/승격
- [ ] 이미 열린 파일 클릭 → 포커스 이동

### 2.2 Quick Switcher (Ctrl+O)
- [ ] 파일 선택 → 표준 탐색 동작

### 2.3 북마크 (Bookmarks)
- [ ] 싱글 클릭 → 표준 탐색 동작
- [ ] 더블 클릭 → Permanent로 승격

### 2.4 검색 결과 (File Search)
- [ ] 싱글 클릭 → 표준 탐색 동작
- [ ] 더블 클릭 → Permanent로 승격

### 2.5 그래프 뷰 (Graph View)
- [ ] 그래프 뷰 열기 → 표준 탐색 동작
- [ ] 노드 싱글 클릭 → 표준 탐색 동작
- [ ] 노드 더블 클릭 → Permanent로 승격

### 2.6 링크 클릭
- [ ] 위키링크 클릭 → 표준 탐색 동작
- [ ] Backlinks 패널 클릭 → 표준 탐색 동작
- [ ] Outgoing Links 패널 클릭 → 표준 탐색 동작

### 2.7 최근 파일 / 무작위 노트
- [ ] 클릭 → 표준 탐색 동작

### 2.8 Canvas / PDF
- [ ] Canvas 열기 → 표준 탐색 동작
- [ ] Canvas 편집 → Permanent로 승격
- [ ] PDF 열기 → 표준 탐색 동작 (읽기 전용, 승격 없음)

---
## 3. 더블 클릭 동작
명시적으로 파일을 열겠다는 의도입니다.

| 현재 탭 | 동작 |
|---|---|
| Empty | 해당 탭에 **Permanent**로 열기 |
| Permanent | 보존 → 새 **Permanent** 탭 생성 |
| Preview (다른 파일) | 해당 탭에서 **Permanent**로 교체 |
| Preview (같은 파일) | **Permanent**로 승격 |

**적용 위치:**
- 파일 탐색기
- 북마크
- 검색 결과
- 그래프 뷰 노드
- 탭 헤더

---
## 4. 새 노트 생성
새 콘텐츠를 생성하는 동작은 항상 **Permanent**로 열립니다.

### 4.1 리본 버튼 / Ctrl+N / 우클릭 → 새 노트
| 현재 탭 | 동작 |
|---|---|
| Empty | 해당 탭에 **Permanent**로 생성 + 제목 편집모드 |
| Permanent | 보존 → 새 **Permanent** 탭 생성 + 제목 편집모드 |
| Preview | **보존 (승격 안 함)** → 새 **Permanent** 탭 생성 + 제목 편집모드 |

> **참고**: 새 노트 생성 시 기존 Preview 탭은 승격되지 않고 그대로 유지됩니다.

### 4.2 Unique Note Creator
| 현재 탭 | 동작 |
|---|---|
| Empty | 해당 탭에 **Permanent**로 생성 + 제목 편집모드 |
| Permanent | 보존 → 새 **Permanent** 탭 생성 + 제목 편집모드 |
| Preview | **보존** → 새 **Permanent** 탭 생성 + 제목 편집모드 |

---
## 5. Daily Notes
Daily Notes는 생성/열기 모두 **Permanent**로 처리됩니다.

| 현재 탭 | 동작 |
|---|---|
| Empty | 해당 탭에 **Permanent**로 열기/생성 |
| Permanent | 보존 → 새 **Permanent** 탭 생성 |
| Preview | **보존** → 새 **Permanent** 탭 생성 |

> **판별 기준**: Daily Notes 플러그인의 설정(날짜 포맷, 저장 경로)을 참조하여 판별

---
## 6. 승격 트리거 (Preview → Permanent)
다음 동작이 발생하면 Preview 탭이 자동으로 Permanent로 승격됩니다.

| 트리거 | 설명 |
|---|---|
| **본문 편집** | 에디터에서 첫 글자 입력 시 |
| **인라인 제목 편집** | 노트 상단 제목 수정 시 (300ms debounce) |
| **파일 이름 변경** | vault의 rename 이벤트 발생 시 |
| **Canvas 편집** | 노드 추가/수정/삭제, 연결선 변경 시 |
| **탭 헤더 더블 클릭** | 탭 제목 영역을 더블 클릭 |
| **사이드바 더블 클릭** | 파일 탐색기, 북마크, 검색 결과 등에서 더블 클릭 |
| **그래프 뷰 더블 클릭** | 그래프 노드 더블 클릭 |

> **참고**: PDF는 읽기 전용이므로 승격 트리거가 없습니다.

---
## 7. 전역 동작 규칙
### 7.1 중복 열기 방지
같은 패널 내에서 이미 열려있는 파일을 클릭하면 새 탭을 만들지 않고 기존 탭으로 포커스가 이동합니다.

### 7.2 패널당 Preview 1개
같은 패널(탭 그룹) 내에서는 Preview 탭이 최대 1개만 존재합니다.

**Preview로 파일을 열어야 할 때:**
1. 같은 패널에 기존 Preview 탭이 있으면 → 그 탭을 재사용
2. 없으면:
   - 현재 탭이 Empty → 해당 탭에 Preview로 열기
   - 현재 탭이 Permanent → 새 Preview 탭 생성

### 7.3 Ctrl/Cmd + Click
Obsidian 기본 동작을 따릅니다. (새 탭/새 패널에서 열기 등)

### 7.4 포커스 자동 이동
새 탭이 생성되면 자동으로 해당 탭으로 포커스가 이동합니다.

### 7.5 탭 닫기 시 탐색기 정리
더블클릭으로 열었던 파일의 탭을 닫으면:
- 파일 탐색기의 `activeDom` 상태 정리
- DOM 클래스 (`is-active`, `has-focus`) 제거

---
## 8. 향후 구현 예정 (Phase 2)
| 기능 | 설명 |
|---|---|
| 탭 드래그 (패널 이동) | 다른 패널로 드래그 시 Permanent로 승격 |
| 탭 고정 (Pin) | 고정 시 Permanent로 승격 |
| Split / Duplicate | Permanent 유지 |
| 외부 플러그인 API | 플러그인에서 열 때 Preview/Permanent 선택 가능 |

---
## 기술 구현 요약
### 상태 판별
```typescript
type TabState = "empty" | "preview" | "permanent";

function getTabState(leaf): TabState {
  if (leaf.view?.getViewType() === "empty") return "empty";
  if (previewLeaves.has(leaf)) return "preview";
  return "permanent";
}
```

### 위치 판별 (사용자 멘탈 모델 기반)
```typescript
// 사이드바 vs 메인 영역을 위치로 판단
// 뷰 타입(file-explorer, bookmarks 등)에 의존하지 않음
function getLeafLocation(leaf): "sidebar" | "main" {
  const root = leaf.getRoot();
  if (root === workspace.leftSplit || root === workspace.rightSplit) {
    return "sidebar";
  }
  return "main";
}
```

### 의도 판별
```typescript
type OpenIntent = "browse" | "create";

function determineOpenIntent(file, openState): OpenIntent {
  // 새 노트 생성 (제목 편집모드)
  if (openState?.eState?.rename === "all") return "create";

  // Daily Notes - 플러그인 설정 참조
  if (isDailyNote(file)) return "create";

  return "browse";
}
```

### 패치 포인트
| 메서드 | 역할 |
|---|---|
| `WorkspaceLeaf.openFile` | 파일 열기 시 Preview/Permanent 결정 |
| `WorkspaceLeaf.setViewState` | 비파일 뷰(Graph, Canvas 등) 처리 |
| `WorkspaceLeaf.detach` | 탭 닫힘 시 정리 |
