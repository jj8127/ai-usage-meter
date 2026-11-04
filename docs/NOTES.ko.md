# 구현 노트

이 파일은 **왜 이렇게 만들었는지**를 적어 둔 기록이다. 쓰는 법은
[README.ko.md](../README.ko.md)에 있다.

Claude Code와 Codex CLI의 **잔여 사용량 수집기**. 위젯 UI와 분리된 데이터 층이다.

목적은 두 가지다. 한도 소진으로 작업이 끊기는 것을 막고, 토큰을 리셋 전에 다 못 써서
낭비하는 것을 막는다. 그래서 돌려주는 값은 **잔여 %와 리셋까지 남은 시간**이 중심이다.

## 위젯

```bash
npm run widget
```

항상 떠 있는 스트립 + 클릭하면 열리는 상세 팝업. 트레이 아이콘으로도 조작한다.

| 요청 | 어떻게 |
|---|---|
| 드래그로 위치 조절 | 스트립 전체가 드래그 영역. 놓으면 좌표가 바로 저장되고 베젤이 한 번 밝아진다. 트레이 메뉴의 **위치 잠금**으로 막을 수 있다 |
| 부팅 시 자동 실행 + 위치 복원 | `app.setLoginItemSettings`로 등록. 켤 때마다 저장된 좌표로 복원하고, 모니터가 바뀌어 화면 밖이면 작업 영역 안으로 되돌린다 |
| 플랜 표시 | 스트립에 `Max 5x`, `Plus`. 팝업에는 전체 이름(`ChatGPT Plus`)과 토큰 출처 |
| 어느 서비스인지 | Anthropic·OpenAI 로고로 구분한다. 로고가 이름 역할을 하므로 "Claude"라고 적지 않고 그 자리를 숫자와 카운트다운에 준다 |
| 설정 열기 | 스트립 **오른쪽 위 모서리**의 톱니. 토글이라 열려 있으면 닫는다. 열 때는 설정 카드를 한 번 짚어 준다 |
| 작업표시줄 따라 숨기기 | 작업표시줄이 자동 숨김으로 내려가면 위젯도 같이 사라지고, 올라오면 같이 나타난다. 설정과 트레이 메뉴에서 끌 수 있다 |
| 위젯 크기 | 아주 작게(0.7) / 작게(0.85) / 보통(1) / 크게(1.15). 창 크기와 페이지 확대율에 같은 수를 곱하므로 글자·막대 비율이 그대로다 |

### 소비 속도와 소진 예측

"81% 남음, 리셋까지 4일 20시간"만 보여주면 끊길지 아닐지는 사용자가 머릿속으로
계산해야 한다. 그 계산을 `src/forecast.js`가 한다.

- 수집기가 받는 **잔여 %만으로** 기울기를 구한다. 새 API도 새 권한도 필요 없다.
- 표본 3개 이상, 5분 이상 모여야 판단한다. 그 전에는 아무 말도 하지 않는다.
- 리셋 전에 바닥나면 **`2일 1시간 뒤 바닥`**(경보색), 창 끝자락인데 많이 남을 것
  같으면 **`리셋 때 62% 남길 듯`**. 평상시에는 리셋 카운트다운 그대로.
- 창이 리셋되면 표본을 버린다. 잔여 %가 위로 튄 표본을 섞으면 기울기가 거꾸로
  나와 "무한히 버틴다"는 예측이 된다.
- `%` 데이터는 `%LOCALAPPDATA%\ai-usage-collector\forecast-state.json`에 남긴다.
  껐다 켤 때마다 표본을 잃으면 한동안 예측을 못 한다.

주의: Anthropic 응답의 `pace` 필드는 이 계정에서 `null`로 와서 쓰지 않는다.

### 임계값 알림

**위젯이 작업표시줄을 따라 숨기 때문에, 색 경고를 볼 기회가 거의 없다.** 색은 보고
있을 때만 쓸모가 있다. 그래서 잔여 25%·10%와 "이 속도면 리셋 전에 바닥" 시점에
OS 알림을 띄운다.

한 번 울린 것은 그 창이 리셋될 때까지 다시 울리지 않는다(`src/alerts.js`).
울린 기록도 파일에 남겨서, 앱을 다시 켜도 같은 알림이 반복되지 않는다.

### Windows 토스트를 쓰지 않는다 — 알림 창을 직접 그린다

이 PC에서는 Windows 토스트가 **끝내 뜨지 않았다.** 확인한 것:

- 시작 메뉴 바로가기(.lnk) 안에 AppUserModelID `dev.jj812.ai-usage-meter`가
  제대로 박혀 있다 (파일 바이트에서 확인)
- `HKCU\...\Notifications\Settings\dev.jj812.ai-usage-meter`도 생긴다
- 그런데 Windows 알림 DB(`wpndatabase.db`)에는 이 앱 핸들러가 **한 건도 없다**
  (전체 413개 중 0). 같은 DB에 Claude는 9건이 있다
- Electron의 `new Notification()`, `tray.displayBalloon()`, **PowerShell로 쏜
  Windows API 토스트** 모두 같았다. 예외도 없이 조용히 사라진다

끊김을 막겠다는 기능이 OS 사정으로 안 뜨면 아무 의미가 없다. 그래서 `app/notice.*`에
작은 창을 직접 그린다. 주 화면 오른쪽 아래, 9초 뒤 자동으로 닫히고, 마우스를
올려 두면 읽을 동안 기다린다. 누르면 상세가 열린다.

덤으로 집중 지원에 묻히지 않고 위젯과 같은 디자인을 쓴다. 대신 알림 센터에는
남지 않는다.

**알림 시험**: 트레이 메뉴의 `알림 시험`, 또는

```powershell
& "$env:LOCALAPPDATA\Programs\ai-usage-collector\AI Usage Meter.exe" --testnotify
```

PowerShell에서는 `%LOCALAPPDATA%`가 확장되지 않고, 따옴표로 묶은 경로는 호출
연산자 `&` 없이는 그냥 문자열로 읽힌다.

이미 떠 있는 앱이 받아서 띄운다(단일 인스턴스 잠금 때문에 두 번째 프로세스는 바로
종료되므로, `second-instance`에서 인자를 보고 처리한다). 집중 지원이나 앱별 알림
설정이 막고 있으면 한도가 25% 아래로 내려가는 순간까지 모른 채로 있게 되므로,
눌러서 바로 확인할 수 있어야 한다.

한 번 띄우고 나면 `HKCU\...\Notifications\Settings\dev.jj812.ai-usage-meter`가
생긴다. 등록 직후에 바로 보면 아직 없을 수 있다.

### 붙잡기: 쓰고 있는 동안에는 사라지지 않는다

작업표시줄이 내려가도 다음 중 하나면 위젯을 남겨 둔다.

- 마우스를 위젯에 올려 두었을 때
- 끌고 있을 때 — 위젯을 끌어 아래 가장자리를 벗어나면 작업표시줄이 바로 내려간다.
  그때 같이 사라지면 드래그가 끊긴다
- 상세·설정 창이 열려 있을 때 — 설정을 만지는 중에 띠가 사라지면 무엇을 바꾸고
  있는지 보이지 않는다

붙잡는 동안에는 이미 걸려 있던 **숨김 타이머를 취소**해야 한다. 그냥 건너뛰기만
하면 앞서 예약된 타이머가 그대로 터져, 붙잡고 있는데도 창이 사라진다.
`--holdtest`가 세 경우와 풀린 뒤까지 확인한다.

### 토글 버튼은 blur로 먼저 닫히는 것을 막아야 한다

팝업은 포커스를 잃으면 닫힌다(`blur` -> `hide`). 그래서 위젯의 설정 버튼을 누르면
**버튼 신호가 도착하기 전에 팝업이 이미 닫혀 있다.** 그대로 "열려 있지 않다"고
판단하면 다시 열어 버려서, 닫으려고 누른 것이 깜빡이고 만다.
직전(320ms 이내)에 닫혔으면 닫는 동작으로 친다.

### DOM 마우스 이벤트에 기대지 않는다

플레이트 전체가 `-webkit-app-region: drag`라서 드래그를 OS가 가져간다. 그동안
렌더러에는 마우스 이벤트가 오지 않거나 반쪽만 온다. 실측: 창을 커서 아래로 옮기면
`mouseenter`는 오는데 치울 때 `mouseleave`가 오지 않아 플래그가 켜진 채로 남았다.

그래서 붙잡기는 메인에서 **커서 좌표와 창 좌표를 120ms마다 직접 본다.**
`screen.getCursorScreenPoint()`가 창 사각형 안에 있으면 호버, 창 좌표가 바뀌었으면
드래그다. 이벤트가 오든 안 오든 켜짐·꺼짐이 항상 맞는다.

### 모니터가 여러 대면 작업표시줄도 여러 개다

주 모니터는 `Shell_TrayWnd`, 나머지는 **`Shell_SecondaryTrayWnd`** 클래스를 쓴다.
주 모니터 것만 보면 보조 모니터 작업표시줄이 올라와도 위젯이 나타나지 않는다.
두 클래스를 모두 모아, **하나라도 보이면** 보이는 것으로 본다.

### 작업표시줄 창은 EnumWindows로 찾으면 안 된다

시작 메뉴가 열려 있는 동안 주 작업표시줄(`Shell_TrayWnd`)이 `EnumWindows` 목록에서
**통째로 빠진다.** 실측: 시작 메뉴를 연 뒤 4초 동안 250ms마다 열거했는데 16번 모두
나오지 않았다. 같은 순간 `FindWindow`로는 같은 핸들(`h=65978`)이 그대로 잡혔고,
최상위 창(`parent=0`)이며 `IsWindowVisible=True`, 사각형은 완전히 올라온
상태(`top=1032`, 겹침 48px)였다.

그래서 Win키를 눌러 시작 메뉴를 열면 **작업표시줄은 올라오는데 위젯은 안 떴다.**
감시가 "작업표시줄 없음"도 아니고(보조 모니터 것은 잡힌다) 숨은 것으로 봤다.

창은 `FindWindow`(주)와 `FindWindowEx`(보조, 같은 클래스를 순회)로 찾는다.
`--dump`로 지금 판정과 근거를 볼 수 있다.

### 'moved' 이벤트에 기대지 않는다

이 환경에서는 창을 옮겨도 Electron의 `moved`가 **한 번도 오지 않는다**(실측: 창이
708→716으로 움직였는데 누적 0회). 그래서 드래그와 클릭은 **누른 순간의 창 좌표와
뗀 순간의 좌표를 직접 비교**해 가린다(3px 이상 움직였으면 드래그). 위치 저장도
손을 뗄 때 한다.

이벤트에 기대면 드래그가 전부 클릭으로 잡혀 **손을 뗄 때마다 팝업이 열린다.**
`--clicktest`가 제자리 클릭과 끌고 뗀 경우를 나눠 확인한다.

### 작업표시줄을 따라가는 방법

작업 영역(workArea)으로는 판정할 수 없다. 자동 숨김을 켜면 작업표시줄이 영역을
차지하지 않아, 보이든 안 보이든 값이 같다. 이 PC에서 실측한 값이 그 증거다.

```
작업표시줄  T=1150  B=1198   (높이 48, 그중 2px만 화면 안)
모니터      T=0     B=1152
작업 영역   T=0     B=1152   <- 작업표시줄이 숨어 있는데도 모니터와 같다
```

그래서 작업표시줄 창 사각형과 모니터 사각형이 **얼마나 겹치는지**로 본다. 가로·세로
모두 6px 넘게 걸쳐 있으면 보이는 것, 아니면 숨은 것이다(숨으면 2px만 남는다).
`app/taskbar-watch.ps1`이 150ms마다 창 위치만 읽어 상태가 바뀔 때만 한 줄을 내보내고,
메인 프로세스가 그 줄에 맞춰 창을 서서히 띄우거나 감춘다.

판정은 **전부 C# 안에서** 한다. PowerShell 함수로 쪼개 두었을 때, 겹침 비율이 1.0인
상태(작업표시줄이 완전히 올라온 상태)에서도 감시가 계속 `0`을 내보내 위젯이 아예
나타나지 않았다. `--dump`를 붙여 실행하면 지금 판정과 그 근거를 한 줄로 내보낸다.

```
> powershell -File app/taskbar-watch.ps1 --dump
shown=1  Shell_SecondaryTrayWnd ix=1646 iy=48 -> True; Shell_TrayWnd ix=1920 iy=48 -> True;
```

감시 프로세스가 죽거나 1.5초 안에 답하지 않으면 **보이는 쪽으로** 간다. 숨은 채로
남아 "앱이 안 켜졌다"로 보이는 쪽이 더 나쁘다. 같은 이유로 켤 때는 첫 판정이 올
때까지 투명하게 두어, 띄웠다가 곧장 사라지는 깜빡임을 없앴다.

스트립은 제공자마다 **5H와 WK 두 줄**을 보여준다. 각 줄에 막대·남은 %·초기화까지
남은 시간이 함께 있다.

```
◆ Ultra   5H  ▭▭▭▭▭▭▭▭▭   --   한도 없음
          WK  ▬▬▬▬▬▭▭▭▭   76%  4일 5시간
```

한 줄에 큰 숫자 하나만 두던 때는 그것이 5시간인지 주간인지 매번 되물어야 했다.
둘 다 보이면 물을 일이 없다. 한도가 없거나 값이 없는 줄은 빈 홈과 `--`로 둔다.
0%와 구분되어야 한다.

`app/icons/`의 두 로고는 Anthropic과 OpenAI의 상표다. 어느 서비스의 사용량인지
가리키는 데만 쓴다.

### 플랜 이름은 토큰에 박혀 오고, 오래될 수 있다

플랜은 OAuth 토큰 안의 `rateLimitTier`에서 온다. 이 값은 **토큰 발급 시점에
고정**되므로 플랜을 바꾸면 한동안 옛 값이 남는다. 실제로 Ultra 사용자에게
`default_claude_max_5x`가 왔다.

또 Anthropic이 2026-10 말에 이름을 바꿨다: **Max 5x → Max, Max 20x → Ultra**.
기존 가입자는 자동 이관됐고 가격은 그대로다. 매핑은 새 이름으로 맞춰 뒀다.

그래도 틀릴 수 있으므로 설정에서 **직접 고를 수 있다**(자동 / Pro / Max / Ultra).
사용자가 고른 값이 토큰 값을 이긴다.

### Ultra에는 5시간 한도가 없다

같은 개편에서 Ultra의 5시간 상한이 없어졌다. 그래서 usage 응답의 `five_hour`가
`null`로 온다. 데이터를 못 받은 것이 아니므로, 플랜이 Ultra면 팝업에
"데이터 없음"이 아니라 **"한도 없음"**으로 적는다.

## 색

바탕은 잉크 네이비 `#0f172a`다. 중립 회색보다 푸른 기가 있어 벽지 위에서 자기 바닥으로
읽히고, 그 위에 올리는 색이 탁해지지 않는다. 의미색은 Radix의 다크용 값을 가져왔다.
어두운 바탕에서 검증된 값이다.

모든 값은 바탕 `#0f172a` 기준으로 대비비를 실측했다 (`app/tokens.css`).

| 역할 | 값 | 대비 | 비고 |
|---|---|---|---|
| 본문 | `#f1f5f9` | 16.3:1 | AAA |
| 보조 | `#cbd5e1` | 12.0:1 | AAA |
| 흐림 | `#94a3b8` | 7.0:1 | AAA |
| 미세 | `#64748b` | 3.8:1 | 선·라벨 전용 |
| Claude | `#d9825c` | 6.2:1 | |
| Codex | `#19b8a0` | 7.2:1 | |
| warn | `#ffc53d` | 11.3:1 | Radix amber-9 |
| crit | `#ff5c6c` | 6.0:1 | |
| accent | `#60a5fa` | 7.0:1 | 조작 요소 전용 |

막대는 제공자 브랜드색을 **어둡게 깐 값**(`--claude-muted` `#a8634a`,
`--codex-muted` `#12806f`)으로 그린다. 브랜드를 알아볼 만큼은 보이되, 98% 남은
상태(가장 안전)가 화면에서 가장 밝은 덩어리가 되지 않게 한다. 평상시 막대를 밝게
칠하면 시선을 끄는 정도가 위험도와 거꾸로 간다.

두 muted 값은 상대휘도가 아니라 **지각 밝기(CIE L\*)를 맞췄다** (49.2 / 47.9).
휘도만 맞추면 청록이 주황보다 훨씬 튀어 두 제공자가 형제로 보이지 않는다.

경보는 25% 이하 노랑, 8% 이하 빨강이다. Anthropic이 `limits[].severity`로 직접
판정해 주면 우리 임계값보다 그쪽을 따른다.

### 경보는 색에만 기대지 않는다

Claude의 테라코타 `#d9825c`와 crit `#ff5c6c`은 **명도비가 1.01:1**이다. 색을 못 가리면
위험 상태와 평상시가 구분되지 않는다. 그래서 warn·crit일 때 셀 왼쪽에 2px 선이 선다.
있고 없고로 읽히므로 색각과 무관하고 흑백으로 봐도 보인다.

참고: [Radix Colors 스케일 문서](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale),
[다크 대시보드 팔레트 정리](https://www.aniq-ui.com/en/blog/dark-mode-dashboard-designs-2026),
[UI 색 조합 가이드](https://skyryedesign.com/design/ux-ui/ui-ux-color-palettes-best-combinations/)

## 모션

움직임은 **바뀐 것을 보여주거나 방금 한 동작을 확인시켜 줄 때만** 쓴다. 영역마다
뿌리지 않는다. 길이는 짧은 기본값의 약 2배다 (`--t-meter` 420ms, `--t-ui` 280ms).

| 언제 | 무엇 |
|---|---|
| 값이 바뀔 때 | 옛 숫자가 위로 빠지고 새 숫자가 올라온다. 막대는 같이 줄어든다 |
| 켤 때 | 플레이트가 한 번 올라온다 (400ms, 한 번만) |
| 스트립에 마우스를 올릴 때 | 그림자만 깊어진다. 띄우지 않는다 — 항상 위에 떠 있는 띠가 들썩이면 거슬린다 |
| 드래그를 놓을 때 | 베젤이 한 번 밝아진다 |
| 팝업을 열 때 | 시트가 짧게 들어오고, 막대가 0에서 제 값까지 차오른다 |
| 새로고침 중 | 머리말 아래를 한 줄이 왕복한다. 얼마나 걸릴지 모르므로 진행률이 아니다 |
| 설정 버튼으로 열 때 | 설정 카드에 테두리가 한 번 들어왔다 빠진다 |

`prefers-reduced-motion`에서는 전부 꺼지고 값만 즉시 바뀐다. CSS는 미디어 쿼리로,
JS는 `matchMedia`로 각각 건너뛴다. `--motiontest`가 두 경우를 모두 확인한다.

### 자동 숨김 작업표시줄은 올라올 때마다 자신을 최상위로 다시 세운다

`alwaysOnTop`을 걸어 둔 것만으로는 작업표시줄이 올라올 때 그 아래로 깔린다.
위젯 윗부분만 한 줄 빼꼼 보인다. 그래서 보이는 동안 0.5초마다, 그리고 작업표시줄이
올라오는 순간에 몰아서 `moveTop()`으로 다시 올린다.

확인은 눈이 아니라 z순서로 한다. 자동 숨김이라도 작업표시줄 창은 살아 있으므로
`--ztest`가 `EnumWindows` 순서에서 둘의 위치를 비교한다 (작은 번호일수록 위).

```
위젯        : 5>AI Usage|Chrome_WidgetWin_1
작업표시줄  : 24>|Shell_TrayWnd
위젯이 작업표시줄보다 위인가: true
```

### nativeImage는 SVG를 읽지 못한다

트레이 아이콘을 SVG 데이터 URL로 넘기면 **예외 없이 빈 이미지가 돌아온다.**
작업표시줄에는 아무것도 없는 회색 칸만 남는다. PNG/JPEG만 된다.

그래서 `app/icons/tray.png`(16)와 `tray@2x.png`(32), `tray@3x.png`(48)을 둔다.
각 크기를 그 크기에서 직접 그렸다. 한 장을 늘리거나 줄이면 16px에서 뭉개진다.
`--livecheck`가 아이콘이 비었는지와 크기를 같이 찍는다.

### 투명 창에 BrowserWindow.setOpacity()를 쓰지 않는다

`transparent: true` 창에 창 투명도를 걸면 Windows에서 **per-pixel 알파가 깨진다.**
투명해야 할 둥근 모서리까지 회색으로 차고 내용이 흐려져, 화면에는 "내용 없는 회색
상자"로 보인다. 렌더러는 멀쩡하므로 DOM만 들여다보면 원인을 못 찾는다
(`--livecheck`가 창 투명도와 렌더러 상태를 같이 찍는 이유다).

그래서 작업표시줄을 따라 사라질 때의 페이드는 플레이트의 **CSS opacity**로 하고,
다 사라진 뒤에 `hide()`를 부른다. 창 투명도는 건드리지 않는다.

### 전환이 돌게 하려면 제자리 갱신이어야 한다

스트립은 상태가 올 때마다 DOM을 다시 만들지 않고 **값만 갈아 끼운다**
(`app/widget.js`의 `cells` 맵). 통째로 다시 만들면 매번 새 엘리먼트라서 CSS 전환이
실행되지 않는다. 막대에 420ms를 걸어 둬도 그냥 튄다.

### 숫자 롤은 DOM 글자와 비교하면 안 된다

구르는 동안 DOM에는 아직 옛 숫자가 들어 있다. 글자로 비교하면 그 사이에 온 갱신을
"같은 값"으로 보고 버린 뒤, 롤이 끝날 때 옛 값을 다시 쓴다. 그래서 마지막으로
요청받은 값(`ref.target`)과 비교하고, 롤 중에 새 값이 오면 앞선 롤을 즉시 끝낸다.
`--motiontest`가 이 회귀를 확인한다.

### CSP 주의

두 창 모두 `style-src 'self'`로 두었다. **인라인 `style` 속성은 조용히 버려진다.**
막대 너비처럼 값이 바뀌는 것은 마크업이 아니라 `el.style.width = ...`로 줘야 한다.
실제로 팝업 막대가 이것 때문에 전부 0px로 비어 있었다.

개발용 플래그 두 개가 있다.

```bash
npx electron app/main.js --shot <폴더>   # 두 미터 모양과 팝업을 캡처하고 종료
npx electron app/main.js --movetest      # 좌표 저장·화면 밖 복귀를 확인하고 종료
npx electron app/main.js --clicktest     # 설정 버튼 -> 팝업 경로를 확인하고 종료
npx electron app/main.js --motiontest    # 숫자 롤과 롤 중 갱신 경합을 확인하고 종료
npx electron app/main.js --tbtest        # 작업표시줄 따라 숨기기를 확인하고 종료
npx electron app/main.js --livecheck <폴더>  # 평소 조건으로 띄운 뒤 창·렌더러 상태를 읽고 캡처
npx electron app/main.js --ztest         # 작업표시줄보다 위에 있는지 z순서로 확인하고 종료
npx electron app/main.js --holdtest      # 호버·드래그·설정창 중 안 사라지는지 확인하고 종료
npx electron app/main.js --scaletest [폴더]  # 배율이 창 크기·확대율에 먹는지 확인하고 종료
```

모든 플래그는 사용자 설정을 바꾸지 않는다. `--shot`은 미터 모양을, `--tbtest`는
따라가기 설정을 건드리지만 나가기 전에 원래 값으로 되돌린다. 또 플래그로 돌 때는
작업표시줄 감시를 켜지 않는다. 숨은 작업표시줄에 맞춰 위젯이 사라지면 캡처가
빈 화면이 된다.

## 설치본 만들기

```bash
npm run dist
```

`dist\AI Usage Meter-0.1.0-setup.exe` (약 96MB)가 나온다. NSIS 원클릭 설치본이고
관리자 권한 없이 사용자 폴더(`%LOCALAPPDATA%\Programs\AI Usage Meter`)에 들어간다.
`npm run pack`은 설치본 없이 `dist\win-unpacked\`만 만든다.

제품 이름은 **AI Usage Meter**다. 비슷한 이름의 다른 도구와 설치 경로·시작 프로그램
항목이 겹치지 않도록 패키지 이름(`ai-usage-collector`)과 따로 둔다.

### 서명하지 않았다

처음 실행할 때 SmartScreen이 "알 수 없는 게시자"로 막는다. **추가 정보 → 실행**으로
넘어가면 된다. 없애려면 코드 서명 인증서가 필요하다.

### taskbar-watch.ps1은 asar 밖에 둔다

PowerShell은 외부 프로세스라 `app.asar` 안을 읽지 못한다. 그래서
`asarUnpack`으로 꺼내고, 코드에서도 경로의 `app.asar`를 `app.asar.unpacked`로
바꿔서 넘긴다. 둘 중 하나만 빠뜨리면 묶인 앱에서 작업표시줄 따라가기가 조용히
죽는다 (위젯은 멀쩡히 뜨므로 눈으로는 모른다).

### 자동 실행 등록 이름

앱은 실행될 때 자기 경로로 시작 프로그램에 등록한다. 개발용으로 돌리면
`electron.app.Electron`이, 묶인 앱은 `electron.app.AI Usage Meter`가 생긴다.
**개발용으로 실행한 뒤에는 그 항목이 남아 부팅 때 같이 뜬다.** 설정에서 자동 실행을
껐다 켜거나 다음 한 줄로 지운다.

```bash
powershell -Command "Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'electron.app.Electron'"
```

## 수집기만 쓰기

```bash
node bin/cli.js            # 사람이 읽는 표
node bin/cli.js --json     # 위젯·스크립트용 JSON
node bin/cli.js --watch=60 # 60초마다 갱신
node bin/cli.js --no-cache # 디스크 캐시 무시
```

코드에서:

```js
import { collectAll, createCache, loadCache, saveCache } from "./src/index.js";

const cache = createCache();   // 프로세스가 들고 있어야 한다
loadCache(cache);              // 부팅 직후에도 바로 숫자가 보이게
const report = await collectAll(cache);
saveCache(cache);
```

`collectAll`은 `Promise.allSettled`를 쓴다. 한쪽이 실패해도 다른 쪽은 그대로 나온다.

## 돌려주는 모양

```js
{
  provider: "claude",
  status: "ready" | "stale" | "error",
  error: null,
  plan: "Max 5x",                       // 사람이 읽는 플랜 이름
  planRaw: { rateLimitTier, subscriptionType },
  tokenSource: "claude-desktop",        // 어느 경로로 토큰을 얻었는지
  tokenExpiresAt: "2026-11-13T06:40:51.078Z",
  session: { usedPercent, leftPercent, resetsAt, resetInMs, resetCountdown, exhausted } | null,
  weekly:  { ...같은 모양 } | null,
  models:  { opus, sonnet },            // 모델별 주간 한도
  pace: null,                           // 소비 속도. Anthropic이 주면 그대로 전달
  limits: [ { kind, group, percent, severity, resets_at, scope, is_active } ],
  updatedAt, cache: "live" | "fresh" | "stale" | "miss"
}
```

`status`가 `error`면 `session`·`weekly`·`plan`이 모두 `null`이다. **추정치를 만들지 않는다.**
마지막 실측값이 있으면 `stale`로 그 수치를 그대로 유지하고 `staleAgeMs`를 함께 준다.

## 토큰 경로 (순서대로 시도)

| 순서 | 소스 | 방식 | 이 PC에서 |
|---|---|---|---|
| 1 | Claude 데스크톱 앱 | `Local State`의 `os_crypt.encrypted_key` → DPAPI → AES-256-GCM으로 `config.json`의 `oauth:tokenCacheV2` 복호화 | **동작** |
| 2 | Claude Code CLI | `~/.claude/.credentials.json`의 `claudeAiOauth.accessToken` | 비어 있음 (CLI `/login`을 안 거쳤음) |
| 3 | 환경변수 | `CLAUDE_CODE_OAUTH_TOKEN` | 없음 |

Codex는 `codex app-server`를 자식 프로세스로 띄워 JSON-RPC로 `account/read`,
`account/rateLimits/read`를 호출한다. 실패하면 `~/.codex/auth.json`의 id_token JWT에서
**플랜만** 읽고 사용량은 `null`로 둔다.

실패한 경로의 이유는 모아 두므로 진단이 쉽다:

```js
const { credential, attempts } = await resolveToken();
// attempts: [{ source: "claude-desktop", error: "..." }, ...]
```

## 설계에서 일부러 정한 것

1. **5시간 창과 주간 창을 독립 처리한다.**
   `five_hour`가 `null`로 오는 계정이 실제로 있다(이 계정이 그렇다). 그때도 주간 수치는
   정상으로 온다. 한쪽이 비었다고 응답 전체를 에러로 버리면, 멀쩡한 값까지 사라진다.

2. **플랜은 `rateLimitTier`를 먼저 본다.**
   `subscriptionType`은 `"max"`까지만 알려 준다. Max 5x와 Max 20x(현 Ultra)를 구분해
   주는 것은 `rateLimitTier`(`default_claude_max_5x`)뿐이다.

3. **마지막 실측값을 디스크에 남긴다.**
   메모리 캐시만 두면 컴퓨터를 켜서 위젯이 막 떴을 때 첫 조회가 끝날 때까지 숫자가 비고,
   그 첫 조회가 429를 맞으면 보여 줄 값이 아예 없다.
   `%LOCALAPPDATA%\ai-usage-collector\last-usage.json`에 정규화된 사용량만 적는다.
   **토큰은 적지 않는다.**

## 레이트리밋

`api.anthropic.com/api/oauth/usage`는 1분 안에 두 번째 호출을 하면 **429**를 준다.
그래서 TTL 60초 안에서는 재호출하지 않고, 429를 맞으면 `Retry-After` 동안 호출 자체를
막는다. 이 동작은 `test/collector.test.js`에서 검증한다.

## 테스트

```bash
npm test
```

33개. 네트워크를 타지 않는다. `fetch`와 시계를 주입해 429·stale·TTL 경로를 검증한다.

## 한계

- **Windows 전용.** DPAPI를 쓴다. macOS는 키체인, Linux는 별도 경로가 필요하다.
- 아직 **패키징하지 않았다.** 자동 실행은 `electron.exe <app/main.js>`로 등록되므로
  이 폴더를 옮기거나 지우면 끊긴다. `electron-builder`로 묶으면 해결된다.
- 배율이 다른 모니터가 섞여 있으면 창을 옮길 때 Windows가 크기를 다시 계산한다.
  `moved`/`resize`에서 크기를 다시 못 박아 막았지만, 1.25 배율에서 높이가 46 대신
  47px로 잡힌다(반올림). 고정값이라 더 늘어나지는 않는다.
- 토큰 **갱신(refresh)은 구현하지 않았다.** 매 수집마다 파일을 다시 읽으므로, 데스크톱
  앱이 켜져 있으면 앱이 갱신한 토큰을 그대로 집어 온다. 앱을 오래 끄고 토큰이 만료되면
  실패한다.
- `pace`는 이 계정 응답에서 `null`로 와서 **내부 구조를 확인하지 못했다.** 값이 들어오면
  그대로 전달한다.
- Codex 쪽 사용량은 `app-server`가 유일한 소스다. 위젯이 하는 `state_5.sqlite` 추정은
  구현하지 않았다.
