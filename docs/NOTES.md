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

### 용어 주의사항

- **Leaf**: "탭"을 의미 (사이드바 패널과 헷갈리지 말 것)
- **activeDom**: 파일 탐색기와 tree 두 곳에 존재 (별개 객체)
- **tree**: 탭의 tree가 아니라 사이드바 뷰 내부의 tree 위젯
