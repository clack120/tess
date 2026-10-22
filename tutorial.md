# Tess 언어 가이드

Tess는 엔트리(playentry.org)의 블록 코드를 텍스트로 작성하기 위한 프로그래밍 언어입니다.
이 문서는 Tess로 작품을 만드는 방법을 다룹니다.

_(설치 및 실행 방법은 [README.md](./README.md)를, 컴파일러 내부의 특수 규칙은 [SPEC-ADDENDUM.md](./SPEC-ADDENDUM.md)를 참고하세요.)_

---

## 1. 시작하기

다음은 Tess로 작성된 간단한 작품 예제입니다.

```tess
project:
  title "내 첫 작품"
  fps 60
end

scene "메인화면":
  object "고양이":
    # Initial properties.
    default costume 기본 "cat.png"
    size = 150
    x = 0
    y = -50

    # Global and object-local variables.
    var 체력 = 100

    # Event scripts.
    when start do
      say "안녕!" for 2

      forever:
        if key_down("right"):
          x += 5
        end
        wait 0.02
      end
    end
  end
end
```

블록을 열 때는 `do`, `then`, `:` 중 편한 것을 사용하고, 닫을 때는 `end`를 씁니다.

---

## 2. 변수와 리스트

변수와 리스트는 선언한 위치에 따라 **전역**과 **지역**으로 나뉩니다.

```tess
# Top-level declarations are global.
var 점수 = 0
list 인벤토리 = ["검", "방패"]

object "플레이어":
  # Object declarations belong to that object.
  var 속도 = 5

  when start do
    점수 += 10
    속도 *= 2

    in 인벤토리 add "포션"
    remove 인벤토리[1]      # 리스트의 첫 번째 항목 삭제
  end
end
```

---

## 3. 조건과 반복

`and`와 `or`는 Entry처럼 양쪽 식을 모두 평가합니다. `i > 0 and 글자[i] == "a"`로 범위 밖 접근을 막을 수는 없습니다. 먼저 범위를 검사한 뒤 안쪽 `if`에서 글자를 읽으세요.

`switch`는 선택할 값을 한 번 계산하고, 리터럴을 적은 첫 `case`만 실행합니다. 여러 값은 쉼표로 묶고, 어떤 값도 맞지 않을 때 실행할 `default`는 마지막에 둡니다. 다음 분기로 이어지지 않으므로 `break`는 필요 없습니다. 분기 안의 `break`·`continue`는 감싸고 있는 반복문에 적용됩니다.

```tess
switch 점수:
case 0:
  say "아직 시작 전"
case 1, 2:
  say "시작!"
default:
  say "진행 중"
end
```

```tess
when start do
  # Conditions.
  if 점수 >= 100:
    say "클리어!"
  else:
    say "진행 중"
  end

  # Loops.
  repeat 5:
    forward 10
  end

  # Include both ends; step defaults to 1, and step -1 counts backward.
  for i from 1 to 10 step 2:
    say i
  end

  while 체력 > 0:
    wait 1
  end

  # Wait until a condition becomes true.
  until touching("도착점"):
    move 5 0
  end
end
```

---

## 4. 움직임과 생김새

```tess
when start do
  # Movement.
  x = 100               # x 좌표를 100으로 위치하기
  y += 50               # y 좌표를 50만큼 바꾸기
  move 20 -20           # x, y 만큼 이동하기
  go "mouse"            # 마우스 포인터로 이동하기
  forward 10 at 90      # 90도 방향으로 10만큼 움직이기
  bounce                # 화면 끝에 닿으면 튕기기

  # Rotation.
  angle = 90            # 방향을 90도로 정하기
  turn 45               # 방향을 45도만큼 회전하기
  look "적"             # '적' 오브젝트 쪽 바라보기

  # Appearance.
  show                  # 모양 보이기
  hide                  # 모양 숨기기
  costume = "공격"      # '공격' 모양으로 바꾸기
  next costume          # 다음 모양으로 바꾸기

  effect_color = 50     # 색깔 효과 정하기
  clear effects         # 효과 모두 지우기
end
```

---

## 5. 이벤트와 신호

```tess
when start do              # 시작하기 버튼을 클릭했을 때
when click do              # 오브젝트를 클릭했을 때
when key "space" do        # 스페이스 키를 눌렀을 때
when scene start do        # 장면이 시작되었을 때
when cloned do             # 자신의 복제본이 처음 생성되었을 때

---

when start do
  send "게임시작"          # 신호 보내기 (바로 다음 줄 실행)
  call "보스등장"          # 신호 보내고 기다리기 (끝날 때까지 대기)
end

when signal "게임시작" do  # 신호를 받았을 때
  clone "적"               # '적' 오브젝트 복제하기
end
```

---

## 6. 객체 정보와 내장 함수

자신이나 다른 오브젝트의 상태를 읽거나 수학 계산을 할 수 있습니다. 대상의 이름을 생략하면 '자기 자신'을 의미합니다.

```tess
when start do
  # Object state.
  var 내위치 = x
  var 마우스y = y("mouse")
  var 적거리 = distance("적")
  var 지금모양 = costume

  # Conditions and runtime state.
  if mouse_down: ... end           # 마우스를 클릭했는가?
  if touching("벽"): ... end       # 벽에 닿았는가?
  if timer > 10: ... end           # 초시계 값

  # Math and helper functions.
  var 랜덤 = random(1, 10)         # 1부터 10 사이 무작위 수
  var 작은값 = min(7, 3)          # 3 (max는 큰 값)
  var 이름길이 = length("엔트리")    # 문자열 길이
  var 첫글자 = "엔트리"[1]         # "엔". 함수 결과와 괄호식에도 [위치]를 붙일 수 있음
  var 시작확인 = starts_with("엔트리", "엔")  # true
  var 끝확인 = ends_with("엔트리", "리")      # true
  var 정리 = trim("  엔트리  ")          # "엔트리" (trim_start/trim_end는 한쪽만)
  var 반복 = repeat_text("ab", 3)       # "ababab"
  var 채움 = pad_start("7", 4, "0")    # "0007" (pad_end는 뒤에 채움)
end
```

문자열 반복 횟수·padding 목표 길이는 소수점을 버립니다. 0 이하이면 반복은 빈 문자열, padding은 원래 문자열입니다. padding의 채울 글자를 생략하면 공백이며, 빈 문자열을 주면 원래 문자열을 돌려줍니다. 목표 길이를 넘는 마지막 채움은 잘립니다. `trim`은 탭·줄바꿈·유니코드 공백도 지웁니다.

---

## 7. 글상자, 붓, 소리

일반 `object` 대신 `text` 키워드를 사용하면 글상자를 만들 수 있습니다.

```tess
# Text boxes.
text "점수판":
  font_color = #ff0000
  bg_color = transparent

  when start do
    write "점수: "
    append 점수      # 뒤에 이어 쓰기
  end
end

# Pen and sound.
object "펜":
  draw_width = 5
  draw_color = #0000ff
  sound 팝 "pop.mp3"

  when start do
    start draw                 # 그리기 시작
    play sound "팝" for 1      # 1초간 소리 재생
    stop draw                  # 그리기 멈춤
    clear draw                 # 모든 붓 지우기
  end
end
```

---

## 8. 함수 (Function)

자주 사용하는 로직을 함수로 묶을 수 있습니다. `return 값`은 조건문·반복문 안에서도 함수를 끝내고 값을 돌려줍니다. 값 없는 `return`은 함수만 끝냅니다. 값을 돌려주는 함수에서 값 없이 끝나는 경로의 결과는 0입니다.

함수의 `var`는 호출마다 독립된 지역 변수입니다. 중첩 블록에서 같은 이름으로 선언하면 그 블록에서만 바깥 변수를 가립니다. 같은 범위에서 같은 이름을 다시 선언하면 오류입니다. Entry 지역 변수의 규칙상 빈 문자열과 `false`를 지역 변수로 읽으면 0이 됩니다.

```tess
object "플레이어":
  # A function called as a statement.
  function 이동하기(속도):
    forward 속도
    bounce
  end

  # A function returning a value.
  function 대미지계산(기본공격력):
    if 기본공격력 <= 0:
      return 0
    end
    var 크리티컬 = random(1, 2)
    return 기본공격력 * 크리티컬
  end

  when start do
    이동하기(10)
    var 최종대미지 = 대미지계산(50)
  end
end
```

---

## 9. 파일 나누기 (모듈화)

작품이 커지면 오브젝트별로 파일을 나누어 관리할 수 있습니다. `use` 키워드는 지정한 파일의 코드를 그 자리에 그대로 붙여 넣습니다.

**`main.tess`**

```tess
scene "게임화면":
  use "objects/player.tess"
  useobject "objects/enemy.tess" # useobject를 사용할 경우 파일에서 object "":...end 를 생략할 수 있습니다.
end
```

**`objects/player.tess`**

```tess
object "플레이어":
  x = -100
  when start do
    say "준비 완료!"
  end
end
```
