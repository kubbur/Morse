import {setSidetoneMuted} from "./morse-paddle.js";
document.querySelector("morse-paddle-input").addEventListener("paddlechange", ({detail}) => {
  const timing=document.getElementById("timing");
  timing.hidden=detail.status!=="ready";
  timing.textContent=detail.wpm===detail.effectiveWpm ? `${detail.wpm} WPM` :
    `${detail.wpm} WPM characters · ${detail.effectiveWpm} WPM Farnsworth`;
  for (const key of ["dit","dah"]) {
    const indicator = document.getElementById(key);
    indicator.classList.toggle("down",detail[key]);
    indicator.querySelector("strong").textContent = detail[key] ? "Pressed" : "Released";
  }
});

for (const button of document.querySelectorAll("[data-sidetone]")) {
  button.addEventListener("click", async () => {
    const muted = button.dataset.sidetone === "mute";
    const result = document.getElementById("sidetone-result");
    try {
      await setSidetoneMuted(muted);
      result.textContent = muted ? "Muted" : "Unmuted";
    } catch (error) {
      result.textContent = error.message;
    }
  });
}
