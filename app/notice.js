import { PROVIDER_ICONS } from "./shared.js";

const notice = document.getElementById("notice");
const logo = document.getElementById("logo");
const titleEl = document.getElementById("title");
const bodyEl = document.getElementById("body");

/**
 * 알림 하나를 그린다. 메인이 창을 띄운 직후에 내용을 보낸다.
 * 같은 창을 다시 쓰므로 들어오는 동작을 매번 되감는다.
 */
window.usage.onNotice((n) => {
  titleEl.textContent = n.title ?? "";
  bodyEl.textContent = n.body ?? "";
  bodyEl.hidden = !n.body;

  const src = PROVIDER_ICONS[n.provider] ?? "";
  logo.src = src;
  logo.alt = n.provider ?? "";

  notice.className = "notice";
  if (n.provider) notice.dataset.provider = n.provider;
  if (n.level === "warn" || n.level === "crit") notice.classList.add(n.level);

  // 레이아웃을 한 번 확정한 뒤 켜야 전환이 실행된다.
  requestAnimationFrame(() => notice.classList.add("shown"));
});

// 본문을 누르면 상세를 연다. 닫기 버튼은 거기까지 올라가지 않게 막는다.
notice.addEventListener("click", () => window.usage.noticeClick());
document.getElementById("close").addEventListener("click", (e) => {
  e.stopPropagation();
  window.usage.noticeClose();
});

// 마우스를 올려 둔 동안에는 자동으로 닫히지 않는다. 읽는 중에 사라지면 곤란하다.
notice.addEventListener("mouseenter", () => window.usage.noticeHold(true));
notice.addEventListener("mouseleave", () => window.usage.noticeHold(false));
