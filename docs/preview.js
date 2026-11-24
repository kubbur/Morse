const play = document.querySelector("#play-a");
const tone = document.querySelector("#tone");
const status = document.querySelector("#play-status");

play.addEventListener("click", async (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  try {
    tone.currentTime = 0;
    await tone.play();
  } catch {
    status.textContent = "Audio playback is unavailable.";
  }
});

tone.addEventListener("playing", () => { status.textContent = "Playing dit dah"; });
tone.addEventListener("ended", () => { status.textContent = ""; });
