# IDE Preview Plugin - 개발 노트

## 사이드바 뷰별 DOM 구조 차이 (2024년 확인)

### 파일 탐색기 (file-explorer)
- **내부 상태**: `view.activeDom` 사용
- **DOM 속성**: `data-path` 속성 있음
- **선택 클래스**: `is-active`, `has-focus`
- **DOM-related keys**: `activeDom`, `_revealActiveFileQueued`, `headerDom`, `fileItems`

### 북마크 (bookmarks)
- **내부 상태**: `view.activeDom` 사용하지 않음 (null)
- **DOM 속성**: `data-path` 속성 **없음** (null)
- **선택 클래스**: `is-active`, `has-focus` (동일)
- **DOM-related keys**: `itemDoms`
- **특징**: `.tree-item-self.bookmark` 클래스 사용

### 검색 (search)
- **내부 상태**: `view.activeDom` 없음
- **DOM-related keys**: `dom`

### 기타 뷰 (outline, tag, backlink, outgoing-link)
- **내부 상태**: DOM 관련 키 없음

---

## 반복된 문제들

### 1. openState.eState mutation 문제
- **현상**: `originalMethod.call()` 호출 후 `openState.eState`가 `{}`로 변경됨
- **원인**: Obsidian 내부에서 openState 객체를 mutate함
- **해결**: 필요한 값은 originalMethod 호출 **전에** 변수에 저장
```typescript
// openState가 originalMethod에 의해 mutate될 수 있으므로 미리 저장
const shouldApplyRename = openState?.eState?.rename === "all";
const result = await originalMethod.call(newLeaf, file, openState);
// 저장해둔 값으로 판단
if (shouldApplyRename) { ... }
```

### 2. 사이드바 선택 상태 해제 문제
- **현상**: 탭 닫을 때 파일 탐색기는 해제되지만 북마크는 안됨
- **원인**: 북마크는 `data-path` 속성이 없어서 `[data-path]` 선택자로 찾을 수 없음
- **해결**: `data-path` 의존하지 않고 사이드바 영역 내 `.is-active`, `.has-focus` 직접 선택

### 3. lastActiveLeaf vs getActiveLeaf 타이밍
- **현상**: 이벤트 핸들러에서 `getActiveLeaf()`가 예상과 다른 탭을 반환
- **원인**: 이벤트 발생 시점과 활성 탭 변경 시점이 다름
- **해결**: `file-open` 이벤트에서 `lastActiveLeaf`를 미리 저장해두고 사용

---

## 사이드바 요소 선택 전략

### 현재 문제가 있는 방식
```typescript
// data-path가 없는 북마크를 찾지 못함
document.querySelectorAll('.is-active[data-path], .has-focus[data-path]')
```

### 개선된 방식
```typescript
// 사이드바 영역 내의 모든 활성 요소 (탭 헤더 제외)
const sidebars = document.querySelectorAll('.workspace-split.mod-left-split, .workspace-split.mod-right-split');
sidebars.forEach(sidebar => {
  const activeItems = sidebar.querySelectorAll('.tree-item-self.is-active, .tree-item-self.has-focus');
  activeItems.forEach(item => {
    item.classList.remove('is-active');
    item.classList.remove('has-focus');
  });
});
```

---

## Obsidian 내부 API 참고

### WorkspaceLeaf
- `detach()`: 탭이 닫힐 때 호출
- `openFile()`: 파일 열 때 호출
- `setViewState()`: 뷰 상태 변경 시 호출 (비파일 뷰 포함)

---

## 사이드바 뷰 내부 구조 (2024년 탐구 결과)

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
- `autoRevealFile`: 자동 표시 설정

**activeDom 구조:**
```typescript
activeDom: {
  el: HTMLElement,        // 전체 항목 요소
  selfEl: HTMLElement,    // 선택 표시되는 요소 (.tree-item-self)
  innerEl: HTMLElement,
  coverEl: HTMLElement,
  info: object,
  rendered: boolean,
  view: View,
  file: TFile,            // 파일 객체 (file.path로 경로 접근)
  tagEl: HTMLElement,
  parent: object
}
```

**fileItems 항목 구조:**
```typescript
fileItems[path]: {
  el, selfEl, innerEl, coverEl, info, rendered, view, file,
  collapsible, collapsed, collapseEl, childrenEl, vChildren, pusherEl, parent
}
```

**주요 메서드:**
- `revealActiveFile()`: 활성 파일 표시
- `revealInFolder(file)`: 특정 파일 표시
- `onDeleteSelectedFiles()`: 선택된 파일 삭제
- **`onFileOpen(file)`**: 파일 열림 시 선택 상태 동기화 (핵심!)

### 북마크 (bookmarks)

**인스턴스 속성:**
- `tree`: 트리 상태 관리 객체 (파일 탐색기와 동일 구조)
- `itemDoms`: 북마크 항목의 DOM 맵
- `plugin`: 북마크 플러그인 참조

**주요 메서드:**
- `_getActiveBookmarks()`: 활성 북마크 가져오기
- `getItemDom(item)`: 항목의 DOM 가져오기
- `onDeleteSelectedItems()`: 선택된 항목 삭제

---

## ⭐ 핵심 발견: explorerView.activeDom vs tree.activeDom (2024년 최신)

### 두 개의 activeDom이 존재한다!
```
explorerView.activeDom: null (또는 object)
tree.activeDom: object (또는 null)
같은 객체인가: false
```

| 속성 | 위치 | 역할 |
|------|------|------|
| `explorerView.activeDom` | View 레벨 | Obsidian이 is-active 클래스 적용 여부 판단에 사용 |
| `tree.activeDom` | Tree 위젯 레벨 | 트리 내부 선택 상태 관리 |

**중요**: 둘은 별개 객체이며, `onFileOpen` 메서드가 둘을 동기화합니다.

### onFileOpen 메서드 분석 (핵심!)
```javascript
// explorerView.onFileOpen 소스코드 (minified에서 복원)
function(e) {
  var t, n = e ? this.fileItems[e.path] : null;
  
  // n(새 항목)이 현재 activeDom과 다르면 처리
  n !== this.activeDom && (
    // focusedItem과도 다르면 다중선택 해제
    n !== this.tree.focusedItem && this.tree.clearSelectedDoms(),
    
    // 기존 activeDom에서 is-active 제거
    null === (t = this.activeDom) || void 0 === t || t.selfEl.removeClass("is-active"),
    
    // 새 activeDom 설정 및 is-active 추가
    // ... (코드 계속)
  )
}
```

**핵심 포인트:**
- `onFileOpen(null)` 호출 시 선택 상태가 완전히 초기화됨
- `activeDom`, `tree.activeDom`, `is-active` 클래스가 모두 일관되게 처리됨
- 이것이 Obsidian의 **공식 선택 상태 초기화 방법**

---

## tree 프로토타입 메서드 분석 (2024년 탐구)

### Proto level 0 (file-explorer 고유)
- `selectItem`: 파일 지원 여부 체크 후 부모 클래스 호출
- `onKeyArrowRight`: 키보드 네비게이션

### Proto level 1 (공통 Tree 클래스)
- `isItem`: 항목 유효성 검사
- `initializeKeyboardNav`: 키보드 네비게이션 초기화
- `toggleCollapseAll`, `setCollapseAll`: 접기/펼치기
- `handleItemSelection`: **항목 선택 핸들러** (핵심!)
- `clearSelectedDoms`: 다중 선택 해제 (is-selected)
- `deselectItem`: 다중 선택에서 제거 (is-selected)
- `selectItem`: 다중 선택에 추가 (is-selected)
- `setFocusedItem`: **포커스 설정** (has-focus 관리)
- `changeFocusedItem`: 키보드로 포커스 이동

### 핵심 메서드 소스코드

**setFocusedItem(item, scrollIntoView=true):**
```javascript
function(e,t){
  void 0===t&&(t=!0),
  e!==this.root&&(
    // 기존 포커스 아이템에서 has-focus 제거
    this.isItem(this.focusedItem)&&this.focusedItem.selfEl.removeClass("has-focus"),
    this.focusedItem=e,
    // 새 아이템에 has-focus 추가
    e&&this.isItem(e)&&(e.selfEl.addClass("has-focus"),t&&this.infinityScroll.scrollIntoView(e))
  )
}
```

**handleItemSelection(event, item):** (일부)
```javascript
function(e,t){
  var n=this, i=n.selectedDoms, r=n.activeDom, o=n.view;
  if(!Tg.isModEvent(e)){
    // Alt+클릭: 토글 선택
    if(e.altKey&&!e.shiftKey)
      return this.app.workspace.setActiveLeaf(o.leaf,{focus:!0}),
             i.has(t)?this.deselectItem(t):(this.selectItem(t),this.setFocusedItem(t,!1),this.activeDom=t),!0;
    // Shift+클릭: 범위 선택
    if(e.shiftKey){...}
    // 일반 클릭: (코드 잘림)
    ...
  }
}
```

### 클래스별 역할
| 클래스 | 용도 | 관리 메서드 |
|---|---|---|
| `is-active` | 단일 활성 항목 (회색 배경) | `onFileOpen` |
| `has-focus` | 키보드 포커스 (진회색 테두리) | `setFocusedItem` |
| `is-selected` | 다중 선택 | `selectItem`/`deselectItem` |

---

## 탭 닫기 시 사이드바 선택 상태 문제 - 최종 해결 (2024년)

### 문제 설명
**더블클릭 → 탭 닫기 → 같은 파일 싱글클릭 시 `is-active` 클래스가 적용되지 않음**

### 재현 단계
1. 파일 탐색기에서 파일을 **더블클릭** (Permanent 탭으로 열림)
2. 열린 탭을 **닫기** (X 버튼 또는 Ctrl+W)
3. 같은 파일을 **싱글클릭**
4. **결과**: 파일은 열리지만 파일 탐색기에서 회색 블록(is-active)이 표시되지 않음

### 원인 분석

**file-open 이벤트 발생 여부가 핵심:**

| 시점 | 정상 케이스 (첫 클릭) | 문제 케이스 (탭 닫은 후 재클릭) |
|------|----------------------|-------------------------------|
| handleOpenFile 완료 시 | file-open 이벤트 발생 ✅ | file-open 이벤트 미발생 ❌ |
| activeDom 설정 | Obsidian이 설정 ✅ | 설정 안됨 ❌ |
| is-active 클래스 | 추가됨 ✅ | 추가 안됨 ❌ |

**근본 원인:**
- `clearAllSidebarSelections`에서 `explorerView.activeDom = null`만 설정
- `tree.activeDom`은 여전히 이전 값 유지
- 두 값의 불일치로 Obsidian 내부 로직이 "이미 선택됨"으로 오판
- 결과: `file-open` 이벤트가 발생하지 않고, `is-active`도 안 붙음

### ❌ 실패한 방법들
```typescript
// 1. explorerView.activeDom만 null로 설정
explorerView.activeDom = null;
// → tree.activeDom과 불일치 발생

// 2. DOM 클래스만 제거
item.classList.remove("is-active", "has-focus");
// → 내부 상태와 불일치 발생

// 3. 둘 다 null로 설정
explorerView.activeDom = null;
tree.activeDom = null;
// → is-active 적용 로직이 여전히 깨짐

// 4. 아무것도 하지 않음
// → Obsidian 기본 버그 그대로 (is-active가 남아있음)
```

### ✅ 올바른 해결책: onFileOpen(null) 사용
```typescript
private clearAllSidebarSelections() {
  const explorerLeaves = this.app.workspace.getLeavesOfType("file-explorer");
  const explorerView = explorerLeaves[0]?.view as any;

  if (explorerView?.onFileOpen) {
    // Obsidian의 공식 메서드로 선택 상태 초기화
    explorerView.onFileOpen(null);
  }
}
```

**왜 이게 정답인가:**
1. `onFileOpen(null)`은 Obsidian이 내부적으로 사용하는 공식 메서드
2. `explorerView.activeDom`, `tree.activeDom`, `is-active` 클래스를 모두 일관되게 처리
3. `clearSelectedDoms()` 등 관련 정리 작업도 자동 수행
4. 내부 구현에 의존하지 않고 공식 API만 사용 → 유지보수성 좋음

### 핵심 원칙

**"Obsidian 내부 상태를 직접 조작하지 말고, 공식 메서드를 사용하라"**

| 작업 | ❌ 잘못된 방법 | ✅ 올바른 방법 |
|------|---------------|---------------|
| 선택 해제 | `activeDom = null` | `onFileOpen(null)` |
| 포커스 해제 | `focusedItem = null` | `tree.setFocusedItem(null)` |
| 다중선택 해제 | `selectedDoms.clear()` | `tree.clearSelectedDoms()` |

---

## 중요 참고사항
- **NOTES.md에 꼼꼼히 기록할 것**: 이 문제 해결을 위해 여러 번의 세션이 필요했음
- **다음 세션을 위해**: 이 문서를 먼저 읽고 현재 상태 파악 후 진행
- **테스트 시 주의**: 플러그인 리로드 후 테스트해야 변경사항 반영됨