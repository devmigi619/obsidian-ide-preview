# IDE Preview Plugin - API 레퍼런스

Obsidian 내부 API와 핵심 발견 사항을 기록합니다.

---

## Obsidian 내부 API

### WorkspaceLeaf (탭)
- `openFile(file, openState)`: 파일 열기
- `setViewState(viewState, eState)`: 뷰 상태 변경 (비파일 뷰 포함)
- `detach()`: 탭 닫기
- `getViewState()`: 현재 뷰 상태 조회
- `view`: 현재 뷰 객체

### Workspace
- `getActiveLeaf()`: 현재 활성 탭 조회
- `getLeavesOfType(type)`: 특정 타입의 탭 목록 조회
- `leftSplit`, `rightSplit`: 좌우 사이드바
- `on('file-open', callback)`: 파일 열림 이벤트

---

## 사이드바 뷰별 DOM 구조 차이

### 파일 탐색기 (file-explorer)
- **내부 상태**: `view.activeDom` 사용
- **DOM 속성**: `data-path` 속성 있음
- **선택 클래스**: `is-active`, `has-focus`
- **주요 속성**: `activeDom`, `fileItems`, `tree`
- **핵심 메서드**: `onFileOpen(file)` - 선택 상태 동기화

### 북마크 (bookmarks)
- **내부 상태**: `view.activeDom` 사용하지 않음
- **DOM 속성**: `data-path` 속성 **없음**
- **선택 클래스**: `is-active`, `has-focus` (동일)
- **주요 속성**: `itemDoms`, `tree`
- **특징**: `.tree-item-self.bookmark` 클래스 사용

### 검색 (search)
- **내부 상태**: `view.activeDom` 없음
- **주요 속성**: `dom`

### 기타 뷰 (outline, tag, backlink, outgoing-link)
- **내부 상태**: DOM 관련 키 없음

---

## 사이드바 뷰 내부 구조

### 공통 패턴: tree 객체

파일 탐색기와 북마크 모두 `view.tree` 객체를 통해 선택 상태를 관리합니다.

```typescript
view.tree: {
  activeDom: object | null,     // 현재 활성(선택된) 항목
  focusedItem: object | null,   // 포커스된 항목
  selectedDoms: Set,            // 다중 선택 (Set 타입)
  prefersCollapsed: boolean,
  isAllCollapsed: boolean,
  ...
}
```

### 파일 탐색기 (file-explorer)

**인스턴스 속성:**
- `activeDom`: 현재 선택된 항목 (**주의: tree.activeDom과 별개 객체!**)
- `fileItems`: 모든 파일/폴더 항목의 맵 (path → DOM 정보)
- `tree`: 트리 상태 관리 객체

**activeDom 구조:**
```typescript
activeDom: {
  el: HTMLElement,        // 전체 항목 요소
  selfEl: HTMLElement,    // 선택 표시되는 요소 (.tree-item-self)
  innerEl: HTMLElement,
  file: TFile,            // 파일 객체 (file.path로 경로 접근)
  ...
}
```

**fileItems 항목 구조:**
```typescript
fileItems[path]: {
  el, selfEl, innerEl, file,
  collapsible, collapsed, collapseEl, childrenEl, ...
}
```

**핵심 메서드:**
- `onFileOpen(file)`: 파일 열림 시 선택 상태 동기화 ⭐
- `revealActiveFile()`: 활성 파일 표시
- `revealInFolder(file)`: 특정 파일 표시

### 북마크 (bookmarks)

**인스턴스 속성:**
- `tree`: 트리 상태 관리 객체 (파일 탐색기와 동일 구조)
- `itemDoms`: 북마크 항목의 DOM 맵

**핵심 메서드:**
- `getItemDom(item)`: 항목의 DOM 가져오기

---

## ⭐ 핵심 발견: explorerView.activeDom vs tree.activeDom

### 두 개의 activeDom이 존재한다!

```javascript
explorerView.activeDom: null (또는 object)
tree.activeDom: object (또는 null)
같은 객체인가: false
```

| 속성 | 위치 | 역할 |
|------|------|------|
| `explorerView.activeDom` | View 레벨 | Obsidian이 is-active 클래스 적용 여부 판단에 사용 |
| `tree.activeDom` | Tree 위젯 레벨 | 트리 내부 선택 상태 관리 |

**중요**: 둘은 별개 객체이며, `onFileOpen` 메서드가 둘을 동기화합니다.

### onFileOpen 메서드 역할

```javascript
// explorerView.onFileOpen 동작 (단순화)
function onFileOpen(file) {
  var newItem = file ? this.fileItems[file.path] : null;

  if (newItem !== this.activeDom) {
    // 기존 activeDom에서 is-active 제거
    this.activeDom?.selfEl.removeClass("is-active");

    // 새 activeDom 설정 및 is-active 추가
    this.activeDom = newItem;
    this.tree.activeDom = newItem;
    newItem?.selfEl.addClass("is-active");
  }
}
```

**핵심 포인트:**
- `onFileOpen(null)` 호출 시 선택 상태가 완전히 초기화됨
- `activeDom`, `tree.activeDom`, `is-active` 클래스가 모두 일관되게 처리됨
- 이것이 Obsidian의 **공식 선택 상태 초기화 방법**

---

## tree 프로토타입 메서드

### 핵심 메서드 목록

| 메서드 | 역할 |
|--------|------|
| `setFocusedItem(item, scroll)` | 포커스 설정 (has-focus 관리) |
| `clearSelectedDoms()` | 다중 선택 해제 (is-selected) |
| `selectItem(item)` | 다중 선택에 추가 (is-selected) |
| `deselectItem(item)` | 다중 선택에서 제거 (is-selected) |
| `handleItemSelection(event, item)` | 항목 선택 핸들러 |

### setFocusedItem 소스코드

```javascript
function setFocusedItem(item, scrollIntoView = true) {
  if (item !== this.root) {
    // 기존 포커스 아이템에서 has-focus 제거
    if (this.isItem(this.focusedItem)) {
      this.focusedItem.selfEl.removeClass("has-focus");
    }

    this.focusedItem = item;

    // 새 아이템에 has-focus 추가
    if (item && this.isItem(item)) {
      item.selfEl.addClass("has-focus");
      if (scrollIntoView) {
        this.infinityScroll.scrollIntoView(item);
      }
    }
  }
}
```

### CSS 클래스별 역할

| 클래스 | 용도 | 관리 메서드 |
|--------|------|-------------|
| `is-active` | 단일 활성 항목 (회색 배경) | `onFileOpen` |
| `has-focus` | 키보드 포커스 (진회색 테두리) | `setFocusedItem` |
| `is-selected` | 다중 선택 | `selectItem`/`deselectItem` |

---

## 핵심 원칙

**"Obsidian 내부 상태를 직접 조작하지 말고, 공식 메서드를 사용하라"**

| 작업 | ❌ 잘못된 방법 | ✅ 올바른 방법 |
|------|---------------|---------------|
| 선택 해제 | `activeDom = null` | `explorerView.onFileOpen(null)` |
| 포커스 해제 | `focusedItem = null` | `tree.setFocusedItem(null)` |
| 다중선택 해제 | `selectedDoms.clear()` | `tree.clearSelectedDoms()` |
| DOM 클래스 제거 | `classList.remove('is-active')` | 공식 메서드 사용 |

**이유**: 직접 조작 시 내부 상태(`activeDom`, `tree.activeDom`, DOM 클래스)가 불일치하여 예상치 못한 버그 발생

---

## 중요 참고사항

### openState.eState mutation 문제

**현상**: `originalMethod.call()` 호출 후 `openState.eState`가 mutate됨

**해결**: 필요한 값은 호출 **전에** 변수에 저장
```typescript
// openState가 mutate될 수 있으므로 미리 저장
const shouldApplyRename = openState?.eState?.rename === "all";
const result = await originalMethod.call(newLeaf, file, openState);
// 저장해둔 값으로 판단
if (shouldApplyRename) { ... }
```

### 북마크는 data-path 속성 없음

**현상**: 북마크는 `data-path` 속성이 없어서 `[data-path]` 선택자로 찾을 수 없음

**해결**: `data-path`에 의존하지 않고 사이드바 영역 내 `.is-active`, `.has-focus` 직접 선택
```typescript
const sidebars = document.querySelectorAll('.workspace-split.mod-left-split, .workspace-split.mod-right-split');
sidebars.forEach(sidebar => {
  const activeItems = sidebar.querySelectorAll('.tree-item-self.is-active, .tree-item-self.has-focus');
  activeItems.forEach(item => {
    item.classList.remove('is-active', 'has-focus');
  });
});
```

### 링크 테스트는 Empty 탭에서 불가능

**현상**: 위키링크, Backlinks, Outgoing Links 테스트는 Empty 탭에서 시작할 수 없음

**이유**: 링크를 클릭하려면 노트가 이미 열려있어야 함
- **위키링크**: 노트 본문 안에 존재
- **Backlinks/Outgoing Links**: 특정 파일이 열려있을 때만 사이드바 패널에 표시

**테스트 가능 상태**: Permanent 탭, Preview 탭만 가능

### 최근 파일(Recent Files)은 플러그인 필요

**현상**: "최근 파일" 기능은 Obsidian 기본 기능이 아님

**확인 사항**:
- **무작위 노트 (Random Note)**: 코어 플러그인, 기본 제공 ✅
- **최근 파일 (Recent Files)**: 별도 플러그인 필요 ❌
  - [Recent Files Plugin](https://github.com/tgrosinger/recent-files-obsidian)
  - Quick Switcher에서 최근 파일을 보여주긴 하지만, 별도 UI/명령은 없음

**테스트 범위**: 무작위 노트만 테스트, 최근 파일 제외

### Canvas 처리

#### Canvas 생성 vs 열기 구분

**Canvas 생성** (리bon 버튼):
- `vault.create()` 호출 → `patchVaultCreate()` 후킹
- `newlyCreatedFiles` Set에 추가
- `handleOpenFile()`에서 `openState.eState.rename = "all"` 강제 설정
- `determineOpenIntent()` → "create" 반환
- **결과**: Create 패턴 → Permanent 탭 (제목 편집 모드)

**Canvas 열기** (파일 탐색기 싱글클릭):
- 기존 Canvas 파일 열기
- `rename` 플래그 없음
- `determineOpenIntent()` → Canvas 확장자 체크 → "browse" 반환
- **결과**: Browse 패턴 → Preview 탭

#### Canvas Permanent 승격

**1. Canvas 편집 (자동 승격)**:
- 노드 추가/수정/삭제
- 연결선 추가/수정/삭제
- 노드 드래그 이동
- 노드 편집기 실행 (더블클릭)
- **감지 방법**: `vault.modify` 이벤트
- **주의**: 시점 이동(스페이스+드래그), 줌(Ctrl+스크롤)은 테스트 필요
  - Canvas 파일(.canvas)은 JSON이며 viewport 정보도 저장될 수 있음

**2. 파일 이름 변경 (자동 승격)**:
- 현재 Preview 탭에 열려있는 Canvas 파일만 승격
- **감지 방법**: `vault.rename` 이벤트 + 파일이 Preview 탭에 열려있는지 확인

**3. 더블클릭 (수동 승격)**:
- 탭 헤더 더블클릭
- 파일 탐색기/북마크/검색 결과 더블클릭

#### determineOpenIntent 로직 (2026-02-09 수정)

```typescript
// 1. rename: "all" → create (Canvas 생성 포함)
if (openState?.eState?.rename === "all") {
  return "create";
}

// 2. Canvas/PDF 확장자 체크 → browse
if (file.extension === "canvas" || file.extension === "pdf") {
  return "browse";
}

// 3. Daily Notes 패턴 → create
// 4. 기본값 → browse
```

이 순서로 Canvas 생성과 열기를 올바르게 구분합니다.

### 더블클릭 승격 메커니즘 (2026-02-09 분석)

#### 핵심 원리: lastActiveLeaf 추적

**문제**: 더블클릭 시점에는 싱글클릭으로 파일이 이미 열려있음. 어떻게 더블클릭 의도를 구분하는가?

**해결**: `lastActiveLeaf` 상태 변수로 "가장 최근 활성 파일" 추적

```typescript
// main.ts:1093-1094 (2026-02-09 수정: PDF 추가)
const viewType = activeLeaf?.view?.getViewType();
if (viewType === "markdown" || viewType === "canvas" || viewType === "pdf") {
  this.lastActiveLeaf = activeLeaf;  // MD, Canvas, PDF 추적
}
```

#### 더블클릭 시나리오 5가지

| 시나리오 | 위치 | 동작 | lastActiveLeaf 사용 여부 |
|---------|------|------|------------------------|
| **1. 탭 헤더 더블클릭** | Line 1189-1195 | 현재 활성 탭 승격 | ❌ (activeLeaf 직접 사용) |
| **2. 사이드바 더블클릭** | Line 1198-1207 | lastActiveLeaf 승격 | ✅ |
| **3. 그래프 뷰 더블클릭** | Line 1210-1215 | lastActiveLeaf 승격 | ✅ |
| **4. 리본 버튼 더블클릭** | Line 1218-1254 | 활성 탭 또는 플래그 설정 | ⚠️ (혼합) |

#### 타이밍 흐름

```
T1: 사용자 더블클릭 시작
T2: 싱글클릭 핸들러 → 파일 열림 (Preview)
T3: file-open 이벤트 → lastActiveLeaf 업데이트 (MD/Canvas만)
T4: 더블클릭 핸들러 → lastActiveLeaf 확인 → 승격
```

#### PDF 더블클릭 승격 (2026-02-09 수정)

**문제 (수정 전)**:
1. PDF는 `lastActiveLeaf`에 추적되지 않음
2. 사이드바 더블클릭 시 lastActiveLeaf 사용 → PDF는 승격 안 됨
3. 탭 헤더 더블클릭만 작동 (activeLeaf 직접 사용)

**해결 (수정 후)**:
- PDF도 `lastActiveLeaf`에 포함 (Line 1094)
- 모든 더블클릭 시나리오에서 PDF 승격 작동

#### 핵심 코드 위치

- `lastActiveLeaf` 선언: Line 123-124
- 업데이트 트리거: Line 1083-1097 (`file-open` 이벤트)
- MD/Canvas 필터: Line 1093-1094
- 더블클릭 핸들러: Line 1186-1255
- 사이드바 처리: Line 1198-1207 (lastActiveLeaf 사용)
- 탭 헤더 처리: Line 1189-1195 (activeLeaf 직접 사용)

### 용어 주의사항

- **Leaf**: "탭"을 의미 (사이드바 패널과 헷갈리지 말 것)
- **activeDom**: 파일 탐색기와 tree 두 곳에 존재 (별개 객체)
- **tree**: 탭의 tree가 아니라 사이드바 뷰 내부의 tree 위젯
