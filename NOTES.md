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
  selectedDoms: object,         // 다중 선택 지원
  prefersCollapsed: boolean,
  isAllCollapsed: boolean,
  ...
}
```

### 파일 탐색기 (file-explorer)

**인스턴스 속성:**
- `activeDom`: 현재 선택된 항목 (tree.activeDom과 동기화됨)
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

### 북마크 (bookmarks)

**인스턴스 속성:**
- `tree`: 트리 상태 관리 객체 (파일 탐색기와 동일 구조)
- `itemDoms`: 북마크 항목의 DOM 맵
- `plugin`: 북마크 플러그인 참조

**주요 메서드:**
- `_getActiveBookmarks()`: 활성 북마크 가져오기
- `getItemDom(item)`: 항목의 DOM 가져오기
- `onDeleteSelectedItems()`: 선택된 항목 삭제

### 선택 상태 관리 방법

**핵심:** `view.tree.activeDom`을 통해 선택 상태 관리

```typescript
// 선택 해제
view.tree.activeDom = null;
view.tree.focusedItem = null;

// DOM 클래스도 함께 정리 필요
selfEl.classList.remove('is-active', 'has-focus');
```

**주의사항:**
- `view.activeDom`과 `view.tree.activeDom`이 별도로 존재할 수 있음
- DOM 클래스와 내부 상태를 함께 관리해야 일관성 유지

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

### 발견 사항

1. **activeDom 설정**: `handleItemSelection`에서 직접 `this.activeDom = t`로 설정
2. **is-active 클래스**: activeDom setter나 다른 곳에서 관리 (소스 확인 필요)
3. **has-focus 클래스**: `setFocusedItem`에서 관리 - 동작 확인됨
4. **is-selected 클래스**: `selectItem`/`deselectItem`에서 관리 (다중 선택용)

### 클래스별 역할
| 클래스 | 용도 | 관리 메서드 |
|---|---|---|
| `is-active` | 단일 활성 항목 (회색 배경) | activeDom 설정 시 자동? |
| `has-focus` | 키보드 포커스 (진회색 테두리) | `setFocusedItem` |
| `is-selected` | 다중 선택 | `selectItem`/`deselectItem` |

### 미해결 문제
- `is-active` 클래스가 어디서 추가되는지 확인 필요
- `activeDom = null` 설정 후 클릭해도 `is-active`가 적용되지 않는 문제

---

## 현재 디버깅 중인 문제 (2024년 - 진행 중)

### 문제 설명
**더블클릭 → 탭 닫기 → 같은 파일 싱글클릭 시 `is-active` 클래스가 적용되지 않음**

### 재현 단계
1. 파일 탐색기에서 파일을 **더블클릭** (Permanent 탭으로 열림)
2. 열린 탭을 **닫기** (X 버튼 또는 Ctrl+W)
3. 같은 파일을 **싱글클릭**
4. **결과**: 파일은 열리지만 파일 탐색기에서 회색 블록(is-active)이 표시되지 않음

### 정상 동작 케이스 (비교용)
- 아무 파일도 열지 않은 상태에서 싱글클릭 → 정상 동작
- 탭 2개 열고 하나 닫은 후 싱글클릭 → 정상 동작
- **오직 탭 1개만 열었다가 닫은 후 싱글클릭할 때만 문제 발생**

### activeDom 프로퍼티 분석 결과
```
tree own descriptor: {"hasDesc":true,"hasGetter":false,"hasSetter":false,"writable":true,"enumerable":true}
proto descriptor: {"hasDesc":false,"hasGetter":false,"hasSetter":false}
view activeDom descriptor: {"hasDesc":true,"hasGetter":false,"hasSetter":false}
```

**핵심 발견: `activeDom`에는 setter가 없다!**
- `is-active` 클래스는 setter를 통해 자동으로 추가되는 것이 아님
- 다른 곳에서 직접 `addClass('is-active')`를 호출해야 함
- `handleItemSelection` 코드의 일반 클릭 부분(잘린 부분)에서 추가할 가능성 높음

### 테스트 방법
1. Obsidian 개발자 도구 콘솔 열기 (Ctrl+Shift+I)
2. 플러그인 리로드
3. 위 재현 단계 수행
4. 콘솔 로그 확인

### 다음 단계 (TODO)
1. **정상 케이스 로그 수집**: 아무 동작 없이 싱글클릭했을 때 어떤 로그가 나오는지 확인
2. **handleItemSelection 전체 코드 확인**: 일반 클릭 시 is-active를 어디서 추가하는지 찾기
3. **두 케이스 비교**: 정상 vs 비정상 케이스에서 차이점 파악

### 시도했지만 실패한 방법들
1. `tree.activeDom = null` 설정 → 문제 해결 안됨
2. `tree.setFocusedItem(null)` 호출 → focusedItem만 정리됨, activeDom은 그대로
3. `tree.deselectItem(item)` 호출 → selectedDoms(다중선택)만 처리, activeDom 무관
4. `tree.clearSelectedDoms()` 호출 → 다중선택만 처리
5. DOM 클래스 수동 제거 + activeDom=null → 문제 해결 안됨

### 핵심 발견 (2024년 최신)

**BEFORE/AFTER 비교로 원인 특정:**

| 시점 | 정상 케이스 | 문제 케이스 |
|---|---|---|
| BEFORE (클릭 전) | tree.activeDom=null, view.activeDom=null | 동일 |
| AFTER (클릭 후) | tree.activeDom=exists, **view.activeDom=exists**, is-active 있음 | tree.activeDom=exists, **view.activeDom=null**, is-active 없음 |

**원인:**
- `view.activeDom = null`로 설정하면 Obsidian의 is-active 적용 로직이 깨짐
- Obsidian은 `tree.activeDom`은 설정하지만 `view.activeDom`은 별도 조건으로 설정
- `view.activeDom`이 null이면 is-active 클래스 추가가 스킵되는 것으로 추정

**최종 해결책 (2024년 확정):**

**핵심 원칙: 사이드바 선택 상태는 절대 건드리지 않는다!**

탭 닫기는 그냥 탭을 닫을 뿐입니다. 파일 탐색기의 선택 상태를 건드릴 이유가 없습니다.
- DOM 클래스(`is-active`, `has-focus`)를 제거해도 문제 발생
- 내부 상태(`tree.activeDom`, `view.activeDom`)를 변경해도 문제 발생
- **아무것도 하지 않는 것이 정답**

```typescript
// ❌ 잘못된 방법 - detach에서 사이드바 상태 건드림
private patchDetach() {
  around(WorkspaceLeaf.prototype, {
    detach(original) {
      return function () {
        clearAllSidebarSelections(); // 이게 문제!
        return original.call(this);
      };
    },
  });
}

// ✅ 올바른 방법 - 아무것도 하지 않음
private patchDetach() {
  // 탭 닫기는 그냥 탭을 닫을 뿐
  // 사이드바 선택 상태는 Obsidian이 알아서 관리함
}
```

**추가 참고 - Obsidian의 내부 상태도 건드리지 않는다:**

```typescript
// ❌ 잘못된 방법 - 내부 상태 손상
tree.activeDom = null;
view.activeDom = null;
tree.focusedItem = null;

// ✅ 올바른 방법 - DOM 클래스만 제거
const sidebars = document.querySelectorAll(
  ".workspace-split.mod-left-split, .workspace-split.mod-right-split"
);
sidebars.forEach((sidebar) => {
  const activeItems = sidebar.querySelectorAll(
    ".tree-item-self.is-active, .tree-item-self.has-focus"
  );
  activeItems.forEach((item) => {
    item.classList.remove("is-active", "has-focus");
  });
});
```

**이유:**
1. `tree.activeDom`, `view.activeDom` 등의 내부 상태를 변경하면 Obsidian의 `handleItemSelection` 로직이 깨짐
2. 특히 `view.activeDom = null` 설정 시, 다음 클릭에서 `is-active` 클래스가 추가되지 않음
3. DOM 클래스만 제거하면 시각적으로는 깔끔해지고, Obsidian 내부 상태는 유지됨
4. 이후 사용자가 클릭하면 Obsidian이 정상적으로 `is-active`를 적용함

**또한 수동으로 선택 상태를 설정하지 않는다:**
```typescript
// ❌ 잘못된 방법 - Obsidian 로직과 충돌
item.selfEl.classList.add("is-active");
view.tree.activeDom = item;
view.activeDom = item;

// ✅ 올바른 방법 - Obsidian이 알아서 처리하도록 맡김
// 아무것도 하지 않음
```

### 중요 참고사항
- **NOTES.md에 꼼꼼히 기록할 것**: 이 문제 해결을 위해 여러 번의 세션이 필요했음
- **다음 세션을 위해**: 이 문서를 먼저 읽고 현재 상태 파악 후 진행
- **테스트 시 주의**: 플러그인 리로드 후 테스트해야 변경사항 반영됨
