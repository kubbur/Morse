import { pairedProgress } from './initial-merge.mjs';
import { syncProfile, mergeProgress } from './sync-data.mjs';
import { MORSE, PROSIGNS, patternFor, LETTERS, DIGITS, PUNCTUATION, KOCH, envelopeAt, gradeAnswer, normalizeText, supportedCharacters } from './morse.mjs';
import { LESSONS, CONTENT, COURSE_LETTERS, COURSE_LEVELS, legacyCourseLevel, earCourseLevelFor, courseStage, courseLevelFor, alphabetFor, isGrowingCourse, isEndless, courseFocus, practiceKey, candidatesFor, randomPrompt, transmissionText } from './lessons.mjs';
import { previousSounds } from './shared-sound.mjs';
import { mirrorSendingSpeed, STORAGE_KEY, DEFAULT_SETTINGS, COURSE_FOCUS_COPIES, loadState, saveState, importState, sanitizeSettings, sanitizeCallsign, newState, resetListeningProgress, resetSendingProgress, startRound, finishRound, recordFirstReview, recordTypedMistakes, localDay, dayStreak, masteryFor, nextPracticeStep, BADGES, collectedBadges } from './progress.mjs';
import { MorseAudio } from './audio.mjs';
import { createCopySession, recordCopyInput, headCopyResponse, copyResponses, copyFeedback, measuredResponse, responseGoal, sanitizePacing } from './recognition.mjs';
import { chooseSalute, saluteForId } from './celebrations.mjs';
import { readProgressFile } from './import-file.mjs';
import { lessonGuidance, guidanceKey, acknowledgeGuidance, rememberGuidanceSound, guidanceListenCount, GUIDANCE_LISTENS, beginRecovery, recoveryCharacter, rememberRecoverySound } from './guidance.mjs';
import { confusionPairs, practiceNeeds, visualHelpPhase } from './review.mjs';
import { radioMission, nextRadioStep, rankGoal } from './endless.mjs';
import { Station } from './station.mjs';
import { PracticeStorage } from './practice-storage.mjs';
import { JOURNAL_KEY, recoverJournal } from './origin-move.mjs';
import qrcode from './vendor/qrcode.mjs';
import { sanitizeFocus, beginFocus, endFocus, focusPhase, focusPrompt, focusProgress } from './focus-level.mjs';
import { LISTENING_GOAL, sanitizeListening, activeListening, queueListening, beginListening, leaveListening, listeningPrompt, checkpointSettings, listeningCheckpoint, guidedListeningPractice } from './by-ear.mjs';
import { practiceSessions, sessionDuration, recordSessionAnswer } from './sessions.mjs';
import { SEND_BADGES, earnedSendBadges } from './sending.mjs';
import { RewardEffects } from './rewards.mjs';
import { SendingUI } from './send-ui.mjs';
import { SENDING_LEVELS } from './sending-course.mjs';

const $ = id => document.getElementById(id);
const $$ = selector => [...document.querySelectorAll(selector)];
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (name, small = false) => `<svg class="icon${small ? ' small' : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
let storage;
try { storage = window.localStorage; } catch { storage = { getItem() { throw new Error(); }, setItem() { throw new Error(); } }; }
const CALLSIGN_INTRO_KEY = 'morse.callsign-intro.v1';
let callsignIntroPending = true;
let callsignIntroBusy = false;
try {
  const marker = storage.getItem(CALLSIGN_INTRO_KEY);
  // An interrupted first visit resumes the prompt. Existing saves keep their
  // privacy choice and are not treated as new learners after this update.
  callsignIntroPending = marker === 'pending' || marker !== 'done' && !storage.getItem(STORAGE_KEY);
} catch { /* Learning remains available when browser storage is blocked. */ }
// Recover an interrupted address move before loading, saving or syncing a
// possibly mixed pair of primary progress and device-journal records.
let interruptedMove = null;
try { interruptedMove = storage.getItem(JOURNAL_KEY); } catch { /* Normal storage warning handles unavailable storage. */ }
if (interruptedMove) {
  try { recoverJournal(storage); }
  catch (error) { location.replace('/move-progress');throw error; }
}
try {
  storage = new PracticeStorage(storage,window.morseMac);
} catch {
  document.body.replaceChildren();
  const notice=document.createElement('p');
  notice.textContent='Morse could not open the learner save. The previous data was retained. Reopen Morse after checking available storage.';
  document.body.append(notice); throw new Error('Learner storage unavailable.');
}
const loaded = loadState(storage, document.cookie);
storage.owner=loaded.state.activeId;
const returningLearner=loaded.state.profiles.find(p=>p.id===loaded.state.activeId);
if (storage.row().foundation || storage.row().choiceSet) $('intro-share').checked=returningLearner.leaderboard;
let state = loaded.state;
let view = 'practice';
let playing = false;
let playingKind = '';
let playbackId = 0;
let toastTimer;
let pendingImport = null;
let pendingResetId = null;
let pendingResetScope = null;
let importController = null;
let importGeneration = 0;
let auditionCharacter = '';
let continuous = false;
let nextSignalTimer = null;
let composing = false;
let lessonComposing = false;
let lessonCompositionAccepted = false;
let celebrating = false;
let copySession = null;
let morseTrace = null;
let morseFrame = null;
let viewportWidth = window.innerWidth;
let fullViewportHeight = Math.max(window.innerHeight, window.visualViewport?.height || 0);
let viewportFrame = null;
let guidanceContext = null;
let answerFocus = null;
let answerFocusFrame = null;
let pendingAnswerKey = null;
let deviceSync = null;
const learnerStations = new Map();
let sender = null;
let choicesKey = '';
let acceptedSound = false;
const soundFields = ['wpm','farnsworth','tone','volume','rise','fall','curve'];
let pairingInvitation = /^#pair=([A-Za-z0-9_-]{43})$/.exec(location.hash)?.[1] || null;
let pairingOffer = null;
let pairingDevicesKey = '';
let recoveryBusy = false, recoveryGeneration = 0;
let identityDirty = false;
let leaderboardLoading = false;
let leaderboardRefreshDue = false;
let leaderboardUpdated = 0;
const mac = window.morseMac;
const pairingOrigin = mac ? (mac.syncMode === 'staging' ? 'http://127.0.0.1:38764' : 'https://morse.kubbur.digital') : location.origin;
let service = {privateSync: !mac, scores: !mac, leaderboard: !mac};
async function refreshService() {
  if (!mac) return;
  try {
    const next = await mac.exchange('capabilities');
    if (next.status !== 200) return;
    const newlyAvailable = !service.scores && next.scores;
    service = next;
    if (deviceSync) renderDeviceSync(deviceSync.status);
    if (newlyAvailable) resumeStations();
  } catch { /* Practice and saving continue offline. */ }
}
if (pairingInvitation) { history.replaceState(null, '', '#practice'); callsignIntroPending = false; }
rememberCallsignIntro();
const dialogOpeners = new WeakMap();
const handledDialogCloses = new WeakMap();
const audio = new MorseAudio();
const rewards = new RewardEffects($('reward-burst'), $('reward-announcement'), document.querySelector('.receiver'));
const profile = () => state.profiles.find(p => p.id === state.activeId) || state.profiles[0];
const levelNumber = settings => isEndless(settings) ? profile().endless.rank : isGrowingCourse(settings) ? settings.courseLevel : settings.level;

function courseByEar(p = profile()) {
  return isGrowingCourse(p.settings) && courseStage(p.settings.courseLevel).byEar === true && !p.round?.focus && !p.round?.byEar;
}

function showsMorse() {
  const p = profile();
  const round = p.round;
  const feedback = round?.visualRevealed || !round?.visualHidden && round?.visualPhase === 'review' && (round.completed || round.attempts > 0) && p.settings.visualSupport !== 'off';
  return (feedback || p.settings.showMorse && !round?.earOnly) && !(p.settings.copyMode === 'head' && playing && playingKind === 'round');
}

function clearMorseTrace() {
  cancelAnimationFrame(morseFrame);
  morseFrame = null;
  morseTrace = null;
  $('morse-symbols').replaceChildren();
  $('morse-placeholder').hidden = false;
  $$('.guidance-pattern > i.is-current').forEach(symbol => symbol.classList.remove('is-current'));
}

function paintMorseTrace() {
  if (!morseTrace) return;
  const elapsed = morseTrace.finished ? Infinity : morseTrace.elapsed();
  let visible = false;
  for (const entry of morseTrace.entries) {
    const started = elapsed >= entry.tone.start;
    entry.element.hidden = !started;
    const sounding = started && elapsed < entry.tone.start + entry.tone.duration;
    entry.element.classList.toggle('is-current', sounding);
    entry.guidanceElement?.classList.toggle('is-current', sounding);
    if (started) { entry.group.hidden = false; visible = true; }
  }
  $('morse-placeholder').hidden = showsMorse() && visible;
}

function fitMorseTrace() {
  if (!morseTrace || !showsMorse()) return;
  const strip = $('morse-symbols'), area = $('live-morse');
  const width = area.clientWidth, height = area.clientHeight;
  if (!width || !height || morseTrace.fittedWidth === width && morseTrace.fittedHeight === height) return;
  // Unsounded marks reserve their places. Fit the complete transmission before
  // revealing its first tone, so neither the trace nor the input moves.
  let low = 1, high = 10;
  for (let i = 0; i < 9; i++) {
    const size = i === 0 ? high : (low + high) / 2;
    strip.style.setProperty('--morse-unit', `${size}px`);
    const fits = strip.scrollWidth <= area.clientWidth && strip.getBoundingClientRect().height <= area.clientHeight;
    if (fits) { low = size; if (size === 10) break; }
    else high = size;
  }
  strip.style.setProperty('--morse-unit', `${low}px`);
  strip.scrollLeft = 0;
  morseTrace.fittedWidth = width;
  morseTrace.fittedHeight = height;
}

function animateMorseTrace() {
  morseFrame = null;
  if (!morseTrace || (!showsMorse() && !morseTrace.guidance) || view !== 'practice') return;
  paintMorseTrace();
  if (!morseTrace.finished && playing) morseFrame = requestAnimationFrame(animateMorseTrace);
}

function renderMorseVisibility() {
  const p = profile(), show = showsMorse();
  $('live-morse').hidden = !show && p.settings.visualSupport !== 'auto' && p.settings.copyMode !== 'head' && !courseByEar(p);
  $('morse-symbols').hidden = !show;
  $('show-morse').checked = show;
  $('show-morse-label').textContent = p.round?.earOnly ? 'Show help' : 'Show Morse';
  $('show-morse').title = p.round?.byEar ? 'Reveal the pattern for this answer. This copy becomes guided practice; your earned letters stay saved.' : p.round?.earOnly ? 'Reveal the pattern for this answer.' : 'Show the sounding dots and dashes';
  $('morse-placeholder').textContent = p.round?.byEar ? playing && playingKind === 'round' ? 'On air · listen…' : p.round?.heard ? 'Your turn · pattern after your answer' : 'By ear · six letters · no time limit' : p.settings.copyMode === 'head' ? playing && playingKind === 'round' ? 'Head-copy · listen first…' : p.round?.heard ? 'Now type the whole group' : 'Head-copy · listen first, then type' : p.round?.visualPhase === 'review' ? 'Listen · pattern after your answer' : p.round?.earOnly ? 'Listening only · help is available' : 'Listen…';
  if (!show) $('morse-placeholder').hidden = false;
  if (show && morseTrace?.round === p.round && !p.round.completed && !p.round.visualUsed) { p.round.visualUsed = true; persist(); }
  if (!show && !morseTrace?.guidance) {
    cancelAnimationFrame(morseFrame);
    morseFrame = null;
  } else if (morseTrace) {
    fitMorseTrace();
    if (morseFrame === null) animateMorseTrace();
  }
}

function startMorseTrace(plan, elapsed) {
  clearMorseTrace();
  const entries = [];
  const groups = [];
  let group;
  let characterIndex = -1;
  const guidance = playingKind === 'guidance' && !!guidanceContext?.repetitions;
  let guidanceSymbols = [];
  let symbolIndex = 0;
  for (const tone of plan.tones) {
    if ((tone.prosignStart ?? tone.characterIndex) !== characterIndex) {
      group = document.createElement('span');
      group.className = `morse-character${plan.text[(tone.prosignStart ?? tone.characterIndex) - 1] === ' ' ? ' word-start' : ''}`;
      group.hidden = true;
      group.dataset.responseIndex = plan.text.slice(0, tone.characterIndex).replaceAll(' ', '').length;
      group.dataset.responseCount = tone.prosign?.length || 1;
      $('morse-symbols').append(group);
      groups.push(group);
      characterIndex = tone.prosignStart ?? tone.characterIndex;
      const card = guidance ? $$('[data-guidance-character]').find(button => button.dataset.guidanceCharacter === (tone.prosign || tone.character)) : null;
      guidanceSymbols = card ? [...card.querySelectorAll('.guidance-pattern > i')] : [];
      symbolIndex = 0;
    }
    const element = document.createElement('span');
    element.className = 'morse-symbol';
    element.dataset.symbol = tone.symbol;
    element.textContent = tone.symbol === '.' ? '·' : '−';
    element.hidden = true;
    group.append(element);
    entries.push({ element, group, tone, guidanceElement: guidanceSymbols[symbolIndex++] });
  }
  morseTrace = { entries, groups, elapsed, guidance, finished: false, round: ['round', 'review'].includes(playingKind) ? profile().round : null };
  renderMorseVisibility();
  renderCopyPace();
}

function finishMorseTrace() {
  cancelAnimationFrame(morseFrame);
  morseFrame = null;
  if (morseTrace) { morseTrace.finished = true; paintMorseTrace(); }
}

function cancelAnswerFocus() {
  answerFocus = null;
  pendingAnswerKey = null;
  cancelAnimationFrame(answerFocusFrame);
  answerFocusFrame = null;
}

function focusCardOpen() {
  return !!guidanceContext?.focus && !!guidanceContext.started && $('guidance-dialog').open;
}

function blockingPracticeDialog() {
  return $$('dialog').some(dialog => dialog.open && !(dialog === $('guidance-dialog') && focusCardOpen()));
}

function focusAnswer({ select = false, fromDialog = null } = {}) {
  if (view !== 'practice' || document.hidden || blockingPracticeDialog() || !profile().round) return;
  if (!answerFocus || answerFocus.learnerId !== profile().id || fromDialog) {
    answerFocus = { learnerId: profile().id, fromDialog, opener: dialogOpeners.get(fromDialog) };
  }
  const input = $('answer');
  if (document.activeElement !== input) input.focus({ preventScroll: true });
  if (select && input.value) input.setSelectionRange(0, input.value.length);
  queueAnswerFocus();
}

function queueAnswerFocus() {
  if (!answerFocus || answerFocusFrame !== null) return;
  answerFocusFrame = requestAnimationFrame(() => {
    answerFocusFrame = null;
    settleAnswerFocus();
  });
}

function canReturnAnswerFocus(active = document.activeElement) {
  return !!answerFocus && ([document.body, document.documentElement, $('answer'), $('play-signal'), answerFocus.opener].includes(active) ||
    !!answerFocus.fromDialog?.contains(active));
}

function settleAnswerFocus() {
  if (!answerFocus) return;
  if (view !== 'practice' || profile().id !== answerFocus.learnerId || !profile().round || blockingPracticeDialog()) {
    cancelAnswerFocus();
    return;
  }
  if (document.hidden || !document.hasFocus()) return;
  if (!canReturnAnswerFocus()) {
    cancelAnswerFocus();
    return;
  }
  const input = $('answer');
  if (document.activeElement !== input) input.focus({ preventScroll: true });
  // Retry only while the browser refuses focus, with one pending frame. Once
  // focused, events maintain ownership across typing and automatic new rounds.
  // Explicit navigation or another control cancels ownership immediately.
  if (document.activeElement !== input) queueAnswerFocus();
}

function closeNativeDialog(dialog) {
  if (!dialog.open) return;
  handledDialogCloses.set(dialog, (handledDialogCloses.get(dialog) || 0) + 1);
  dialog.close();
}

function finishDialog(dialog, { returnToPractice = true } = {}) {
  if (dialog.id === 'callsign-intro-dialog') {
    if (callsignIntroBusy) return;
    callsignIntroPending = false;
    rememberCallsignIntro();
  }
  if (dialog.id === 'guidance-dialog') {
    if (guidanceContext?.focus && profile().focus?.active) returnToCourse({ fromDialog: dialog });
    else finishLessonGuidance();
    return;
  }
  if (dialog.id === 'progress-dialog') { cancelImport(); cancelProgressReset(); }
  stopPlayback();
  closeNativeDialog(dialog);
  if (returnToPractice && view === 'send') sender?.focusKey();
  if (returnToPractice && !showLessonGuidance()) focusAnswer({ select: profile().round?.completed, fromDialog: dialog });
}

function writeAnswerKey(key, start = $('answer').selectionStart, end = $('answer').selectionEnd) {
  const input = $('answer');
  start ??= input.value.length;
  end ??= start;
  const printable = key.length === 1;
  const insertion = printable ? key.slice(0, Math.max(0, input.maxLength - input.value.length + end - start)) : '';
  if (printable && !insertion) return;
  if (!printable && start === end) {
    if (key === 'Backspace') start = Math.max(0, start - 1);
    else end = Math.min(input.value.length, end + 1);
  }
  input.setRangeText(insertion, start, end, 'end');
  input.dispatchEvent(new InputEvent('input', { bubbles: true, data: insertion || null, inputType: printable ? 'insertText' : key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward' }));
}

function updateKeyboardLayout() {
  viewportFrame = null;
  const viewport = window.visualViewport;
  const height = viewport?.height || window.innerHeight;
  const width = viewport?.width || window.innerWidth;
  const top = viewport?.offsetTop || 0, left = viewport?.offsetLeft || 0;
  if (Math.abs(window.innerWidth - viewportWidth) > 40) {
    viewportWidth = window.innerWidth;
    fullViewportHeight = Math.max(window.innerHeight, height);
  } else fullViewportHeight = Math.max(fullViewportHeight, window.innerHeight, height);
  const mobile = window.innerWidth <= 760 && (!viewport || viewport.scale < 1.15);
  const typing = [$('answer'), $('guidance-answer')].includes(document.activeElement);
  const keyboard = view === 'practice' && (typing || document.body.classList.contains('practice-keyboard')) && mobile &&
    (fullViewportHeight - height > 120 || height < 460);
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries({ height, width, top, left, middle: top + height / 2, center: left + width / 2 })) {
    style.setProperty(`--visual-${name}`, `${value}px`);
  }
  document.body.classList.toggle('mobile-viewport', mobile);
  document.body.classList.toggle('short-viewport', height <= 460);
  document.body.classList.toggle('practice-keyboard', keyboard);
  fitMorseTrace();
}

function queueKeyboardLayout() {
  if (viewportFrame === null) viewportFrame = requestAnimationFrame(updateKeyboardLayout);
}

function scheduleNextSignal() {
  clearTimeout(nextSignalTimer);
  const learner = profile();
  const round = learner.round;
  nextSignalTimer = setTimeout(() => {
    nextSignalTimer = null;
    if (!continuous || document.hidden || view !== 'practice' || blockingPracticeDialog() ||
        profile().id !== learner.id || profile().round !== round) return;
    nextRound();
  }, 900);
}

function checkTypedAnswer() {
  const round = profile().round;
  if (playing || view !== 'practice' || document.hidden || blockingPracticeDialog() ||
      !round?.heard || round.completed) return;
  if (normalizeText($('answer').value) === round.target) checkAnswer();
}

function announce(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}

function completeListening(p, options) {
  const result=finishRound(p,options);
  if (result) storage.result(p,'listen',result.awarded,p.stats.rounds.at(-1).id);
  return result;
}

function persist() {
  const success = saveState(storage, state, cookie => { document.cookie = cookie; }, location.protocol === 'https:');
  if (!success) {
    $('saved-status').textContent = 'Not saved — export to keep your progress';
    $('storage-warning').textContent = 'Local storage is unavailable or full. Export your progress from Saved progress before leaving.';
    $('storage-warning').hidden = false;
  }
  if (success) deviceSync?.changed();
  return success;
}

function ensureRound(previous = '', learner = profile()) {
  const p = learner;
  p.focus = sanitizeFocus(p.focus, p.settings);
  p.listening = sanitizeListening(p.listening, p.settings);
  if (p.focus.active && p.listening.active) leaveListening(p);
  if (p.round?.focus && !p.focus.active) p.round = null;
  if (p.round?.byEar && p.round.byEar !== p.listening.active?.id) p.round = null;
  if (!p.round || p.round.key !== practiceKey(p.settings)) {
    if (p.focus.active && !focusPhase(p.focus.active)) endFocus(p);
    const checkpoint = activeListening(p);
    if (checkpoint && (checkpoint.passed || checkpoint.misses >= 2)) leaveListening(p);
    const listening = activeListening(p);
    if (isEndless(p.settings) && p.endless.finished) nextRadioStep(p.endless);
    const mastery = masteryFor(p);
    const introduction = !p.focus.active && !listening && !(isGrowingCourse(p.settings) && courseStage(p.settings.courseLevel).audioCourse) && (p.settings.level === 1 || isGrowingCourse(p.settings) && courseStage(p.settings.courseLevel).newSound) && courseFocus(p.settings) && !mastery.total;
    startRound(p, listening ? listeningPrompt(p, previous) : p.focus.active ? focusPrompt(p.focus.active, previous) : isEndless(p.settings) ? radioMission(p.endless).text : introduction ? courseFocus(p.settings) : randomPrompt(p.settings, p.stats.characters, previous, Math.random, mastery.targetSound, { review: p.review }), { focus: !!p.focus.active, byEar: !!listening });
    if (introduction) Object.assign(p.round, { introduction: true, assisted: true });
  }
}

function nextStepCopy(step) {
  if (step?.track === 'endless') return 'Course complete · endless radio is next';
  if (listeningComesNext(step)) return `Up next: By ear · six letters, then level ${step.courseLevel}`;
  return step?.addedCharacter ? `Next character: ${step.addedCharacter}` : step ? `Up next: level ${step.courseLevel ?? step.level} · ${step.courseLevel ? courseStage(step.courseLevel).label.toLowerCase() : `${step.level} characters`}` : 'Practice complete.';
}

function listeningComesNext(step) {
  const p = profile();
  const checkpoint = listeningCheckpoint(p.settings.courseLevel);
  const id = `${p.settings.copyMode}:${checkpoint?.maintenance ? `ear:${p.settings.courseLevel}` : legacyCourseLevel(p.settings.courseLevel)}`;
  return !!step && step.track !== 'endless' && (checkpoint?.maintenance || !courseStage(step.courseLevel).audioCourse && p.settings.visualSupport === 'auto') && isGrowingCourse(p.settings) && checkpoint &&
    !p.listening.cooldown && !p.listening.records[id]?.passed;
}

function nextGuidanceCharacter(context = guidanceContext) {
  if (!context?.repetitions) return '';
  return context.recovery ? recoveryCharacter(context.round) : context.characters.find(c => guidanceListenCount(profile(), c, context.key) < context.repetitions) || '';
}

function rememberCallsignIntro() {
  try { storage.setItem(CALLSIGN_INTRO_KEY, callsignIntroPending ? 'pending' : 'done'); } catch { /* The primary save reports unavailable storage. */ }
}

function showCallsignIntro() {
  if (!callsignIntroPending || document.hidden || $$('dialog').some(dialog => dialog.open)) return false;
  openDialog('callsign-intro-dialog');
  $('intro-callsign').focus({ preventScroll: true });
  return true;
}

function showLessonGuidance({ reference = false } = {}) {
  if (view !== 'practice' || document.hidden || $$('dialog').some(dialog => dialog.open)) return false;
  if (!reference && showCallsignIntro()) return true;
  const learner = profile();
  if (!reference && learner.listening?.active) return false;
  if (!reference && !learner.round) return false;
  const missed = !reference && !learner.focus?.active && recoveryCharacter(learner.round);
  const focused = learner.focus?.active;
  const refresher = reference && activeListening(learner)?.maintenance ? activeListening(learner) : null;
  const detail = refresher ? {
    key: guidanceKey(learner.settings), reference: true, first: false, repetitions: 0,
    title: refresher.label, copy: 'Tap a sound to hear it. These sounds were introduced earlier in the course.',
    instruction: '', characters: [], examples: refresher.pool.map(text => ({ text, meaning: PROSIGNS[text]?.meaning || `Morse character ${text}` })), button: 'Back to practice',
  } : missed ? {
    recovery: true, round: learner.round, recoveryState: learner.round.recovery,
    key: guidanceKey(learner.settings), first: false, reference: false,
    repetitions: GUIDANCE_LISTENS, characters: [missed],
    title: `Review ${missed}`, copy: 'Look at the letter and listen to the sound.',
    instruction: 'Press the letter three times. Listen each time, then practice resumes.',
  } : focused ? {
    focus: true, key: guidanceKey(learner.settings), first: false, reference, repetitions: 0,
    characters: [...focused.sounds], level: learner.settings.courseLevel,
    title: `Focus on ${[...focused.sounds].join(' & ')}`,
    copy: `Practice these characters, then return to level ${learner.settings.courseLevel}.`,
    instruction: `Two correct singles per sound${focused.maxLength >= 2 ? ', then two clean pairs' : ''}${focused.maxLength >= 3 ? ' and two clean triples' : ''}. Accuracy finishes this level; there is no time limit. Course progress is saved. Esc skips.`,
    button: reference ? 'Back to practice' : 'Start focus level',
  } : lessonGuidance(learner, { reference });
  if (!detail) return false;
  if (detail.repetitions && !detail.recovery && detail.characters.every(c => guidanceListenCount(learner, c, detail.key) >= detail.repetitions)) {
    acknowledgeGuidance(learner, detail.key);
    persist();
    return false;
  }
  stopPlayback();
  const assistedReference = reference && learner.round?.plays && !learner.round.completed;
  if (assistedReference) markAssisted();
  cancelAnswerFocus();
  dialogOpeners.set($('guidance-dialog'), document.activeElement);
  guidanceContext = { learnerId: learner.id, ...detail };
  $('guidance-copy').hidden = false;
  $('guidance-dialog').dataset.reference = String(reference);
  $('guidance-dialog').classList.toggle('is-welcome', detail.first);
  $('guidance-dialog').classList.toggle('is-rehearsal', !!detail.repetitions);
  $('guidance-dialog').classList.toggle('is-recovery', !!detail.recovery);
  $('guidance-dialog').classList.toggle('is-focus', !!detail.focus);
  const celebrateStep = !detail.first && !reference && !detail.focus && !detail.recovery && !isEndless(learner.settings);
  $('guidance-dialog').classList.toggle('is-level-up', celebrateStep);
  $('guidance-eyebrow').textContent = detail.focus ? 'FOCUS PRACTICE' : detail.recovery ? 'CHARACTER REVIEW' : reference ? 'LEARN THE SOUND' : detail.first ? 'GETTING STARTED' : `LEVEL ${detail.level} · WHAT’S NEW`;
  if (celebrateStep) {
    const sparkle = document.createElement('span');
    sparkle.className = 'lesson-spark';
    sparkle.setAttribute('aria-hidden', 'true');
    sparkle.innerHTML = icon('spark');
    for (let i = 0; i < 12; i++) {
      const particle = document.createElement('i');
      const angle = i * Math.PI * 2 / 12, distance = 18 + i % 3 * 8;
      particle.style.setProperty('--spark-x', `${Math.cos(angle) * distance}px`);
      particle.style.setProperty('--spark-y', `${Math.sin(angle) * distance}px`);
      particle.style.setProperty('--spark-turn', `${i * 37}deg`);
      particle.style.setProperty('--spark-delay', `${i % 3 * 30}ms`);
      sparkle.append(particle);
    }
    $('guidance-eyebrow').prepend(sparkle);
  }
  $('guidance-title').textContent = detail.title;
  $('guidance-copy').textContent = detail.copy;
  if (detail.repetitions) {
    const cue = document.createElement('span');
    cue.className = 'guidance-cue';
    cue.setAttribute('aria-hidden', 'true');
    cue.innerHTML = `${icon('eye')}${icon('arrow', true)}${icon('headphones')}`;
    $('guidance-copy').prepend(cue);
  }
  $('guidance-instruction').textContent = (detail.repetitions ? detail.characters.some(c => c.length > 1) ? 'Type the shown letters three times. Listen each time, then practice resumes.' : detail.characters.every(c => /^[A-Z]$/.test(c)) ? 'Press the letter three times. Listen each time, then practice resumes.' : 'Type the shown character three times. Listen each time, then practice resumes.' : detail.instruction) + (assistedReference ? ' This round is for learning; it won’t count toward mastery.' : '');
  $('guidance-instruction').hidden = !$('guidance-instruction').textContent;
  renderGuidanceCharacters();
  $('guidance-characters').tabIndex = detail.repetitions ? 0 : -1;
  $('guidance-examples').innerHTML = !detail.repetitions ? (detail.examples || []).map(entry => `<button type="button" class="guidance-example" data-course-example="${escape(entry.text)}" aria-label="Listen to ${escape(entry.text)}: ${escape(entry.meaning)}"><strong>${escape(entry.text)}</strong><span>${escape(entry.meaning)}</span>${icon('volume', true)}</button>`).join('') : '';
  $('guidance-examples').hidden = !$('guidance-examples').children.length;
  $('guidance-characters').hidden = !detail.characters.length;
  $('guidance-basics').hidden = !!detail.focus || !detail.characters.length;
  $('guidance-close').hidden = !reference && !detail.recovery && !detail.focus;
  $('guidance-close').setAttribute('aria-label', detail.focus ? 'Skip focus exercise and return to course' : detail.recovery ? 'Pause sound practice' : 'Close lesson letters');
  $('guidance-skip').hidden = !detail.first;
  $('guidance-continue').hidden = !!detail.repetitions;
  $('guidance-typing').hidden = !detail.repetitions;
  $('guidance-answer').value = '';
  lessonComposing = false;
  lessonCompositionAccepted = false;
  renderGuidanceProgress();
  clearTimeout(toastTimer);
  $('toast').hidden = true;
  $('guidance-dialog').showModal();
  if (detail.focus && focused.acknowledged && !reference) { startFocusPractice({ play: false }); return true; }
  $(detail.repetitions ? 'guidance-answer' : 'guidance-continue').focus({ preventScroll: true });
  return true;
}

function startFocusPractice({ play = true } = {}) {
  const context = guidanceContext, p = profile();
  if (!context?.focus || !p.focus?.active || context.learnerId !== p.id || context.key !== guidanceKey(p.settings)) return;
  context.started = true;
  p.focus.active.acknowledged = true;
  // Keep the same input, audio clock and progress elements throughout practice.
  // Only their home changes; no second scoring path or replacement textbox.
  $('focus-practice').append($('practice-workspace'));
  $('focus-footer').append($('return-course'));
  $('focus-practice').hidden = false;
  $('focus-footer').hidden = false;
  $('guidance-dialog').classList.add('is-focus-practicing');
  for (const id of ['guidance-copy', 'guidance-characters', 'guidance-instruction', 'guidance-audio-status', 'guidance-continue']) $(id).hidden = true;
  $('guidance-dialog').setAttribute('aria-describedby', 'focus-footer');
  // Older saves may have paused a separate sound-recovery card in this detour.
  // The inline accuracy exercise itself supplies the repeated listening now.
  if (p.round?.focus) p.round.recovery = null;
  persist(); renderPractice(); focusAnswer(); queueKeyboardLayout();
  if (play) {
    if (p.round?.completed) nextRound();
    else playRound();
  }
}

function restorePracticeWorkspace() {
  const workspace = $('practice-workspace');
  if (workspace.parentElement === $('focus-practice')) $('empty-practice').before(workspace);
  if ($('return-course').parentElement === $('focus-footer')) $('choose-lesson').before($('return-course'));
  $('focus-practice').hidden = true;
  $('focus-footer').hidden = true;
  $('guidance-dialog').classList.remove('is-focus-practicing');
  $('guidance-dialog').setAttribute('aria-describedby', 'guidance-copy guidance-instruction');
}

function renderGuidanceCharacters() {
  const context = guidanceContext;
  const characters = context.repetitions ? [nextGuidanceCharacter(context)].filter(Boolean) : context.characters;
  $('guidance-characters').innerHTML = characters.map(character => {
    const pattern = patternFor(character);
    const spoken = [...pattern].map(symbol => symbol === '.' ? 'short' : 'long').join(' · ');
    const element = context.repetitions ? 'div' : 'button';
    return `<${element} ${context.repetitions ? 'role="img"' : 'type="button"'} class="guidance-character" data-guidance-character="${escape(character)}" data-prosign="${!!PROSIGNS[character]}" aria-label="${context.repetitions ? 'Sound' : 'Listen to'} ${escape(character)}: ${spoken}"><strong>${escape(character.length > 1 ? `<${character}>` : character)}</strong>${PROSIGNS[character] ? `<span class="guidance-definition">${escape(PROSIGNS[character].meaning)}</span>` : ''}<span class="guidance-pattern" aria-hidden="true">${[...pattern].map(symbol => `<i data-symbol="${symbol}"></i>`).join('')}</span><small>${spoken}</small><span class="guidance-listen">${icon('volume', true)} Listen</span></${element}>`;
  }).join('');
}

function renderGuidanceProgress() {
  const context = guidanceContext;
  if (!context || context.started) return;
  const previewed = profile().guidance.previewed || '';
  const count = character => context.recovery ? context.recoveryState.counts[character] || 0 : guidanceListenCount(profile(), character, context.key);
  const remaining = context.characters.filter(character => context.repetitions ? count(character) < context.repetitions : !previewed.includes(character));
  const sounding = playing && playingKind === 'guidance';
  $$('[data-guidance-character]').forEach(button => {
    const character = button.dataset.guidanceCharacter;
    button.classList.toggle('is-heard', context.repetitions ? count(character) >= context.repetitions : previewed.includes(character));
    if (context.repetitions) button.querySelector('.guidance-listen').innerHTML = `${icon('volume', true)} Listen · ${count(character)}/${context.repetitions}`;
  });
  $('guidance-audio-status').hidden = !context.characters.length;
  const next = remaining[0] || context.characters.at(-1);
  if (context.repetitions) {
    $('guidance-answer-label').textContent = `${next.length > 1 ? 'Type' : 'Press'} ${next} three times`;
    $('guidance-answer').inputMode = /^\d$/.test(next) ? 'numeric' : 'text';
    $('guidance-answer').placeholder = `Type ${next}`;
    $('guidance-typing').setAttribute('aria-busy', String(sounding));
    $('guidance-audio-status').textContent = `${next} · ${count(next)}/${context.repetitions} listens · ${sounding ? 'Listening…' : `Press ${next}`}`;
    return;
  }
  $('guidance-audio-status').textContent = sounding ? `Playing ${auditionCharacter}` : context.first ? `${context.characters.length - remaining.length} of ${context.characters.length} sounds heard` : '';
  $('guidance-button-label').textContent = context.first && remaining.length ? sounding ? `Playing ${auditionCharacter}…` : `Listen to ${remaining[0]}` : context.button;
  $('guidance-continue').setAttribute('aria-disabled', String(context.first && !!remaining.length && sounding));
}

function continueLessonGuidance() {
  const context = guidanceContext;
  if (!context || context.repetitions) return;
  if (context.focus) { if (!context.started) startFocusPractice(); return; }
  if (context.first) {
    const character = context.characters.find(c => !(profile().guidance.previewed || '').includes(c));
    if (character) {
      if (!playing) playSound(character, { ...profile().settings }, 'guidance', character);
      return;
    }
  }
  finishLessonGuidance({ play: !context.reference });
}

function finishLessonGuidance({ play = false } = {}) {
  if (!guidanceContext) return;
  const context = guidanceContext;
  guidanceContext = null;
  const matches = profile().id === context.learnerId && guidanceKey(profile().settings) === context.key;
  if (matches && context.focus && profile().focus?.active) profile().focus.active.acknowledged = true;
  if (matches && !context.focus && !context.reference && !context.recovery) acknowledgeGuidance(profile(), context.key);
  stopPlayback();
  restorePracticeWorkspace();
  closeNativeDialog($('guidance-dialog'));
  $('guidance-dialog').classList.remove('is-level-up');
  $('guidance-eyebrow').querySelector('.lesson-spark')?.remove();
  $('guidance-characters').replaceChildren();
  $('guidance-answer').value = '';
  lessonComposing = false;
  lessonCompositionAccepted = false;
  if (matches) persist();
  if (matches) focusAnswer({ fromDialog: $('guidance-dialog') });
  // Keep focus and audio activation in the Enter/tap handler for phone keyboards.
  if (play && matches && view === 'practice' && !document.hidden && profile().round) playRound();
}

function typeLessonLetter(event) {
  const input = $('guidance-answer');
  const character = normalizeText(input.value);
  const context = guidanceContext;
  const expected = nextGuidanceCharacter(context);
  if (expected.length > 1 && expected.startsWith(character) && character !== expected) return;
  input.value = '';
  if (!context?.repetitions || context.learnerId !== profile().id || context.key !== guidanceKey(profile().settings)) return;
  if (context.recovery && (context.round !== profile().round || context.recoveryState !== profile().round?.recovery)) return;
  // Some phone keyboards deliver a final input after compositionend. A sound
  // already started by that composition must not be played a second time.
  if (lessonCompositionAccepted) return;
  if (character !== nextGuidanceCharacter(context)) return;
  if (lessonComposing || event.isComposing) lessonCompositionAccepted = true;
  if (playing) return;
  playSound(character, { ...profile().settings }, 'guidance', character);
}

function characterChips(characters) {
  return [...characters].map(c => `<button type="button" class="character-chip${auditionCharacter === c ? ' is-auditioning' : ''}" data-character="${escape(c)}" aria-label="Listen to ${escape(c)}"><strong>${escape(c)}</strong><small>${patternFor(c).replaceAll('.', '·').replaceAll('-', '−')}</small></button>`).join('');
}

function renderHeader() {
  document.documentElement.dataset.theme = state.theme;
  document.body.dataset.activeView = view;
  $('theme-toggle').innerHTML = icon(state.theme === 'dark' ? 'sun' : 'moon');
  $('theme-toggle').setAttribute('aria-label', `Switch to ${state.theme === 'dark' ? 'light' : 'dark'} theme`);
  document.querySelector('meta[name="theme-color"]').content = state.theme === 'dark' ? '#101918' : '#f3f3e9';
  $$('[data-view]').forEach(button => {
    if (button.closest('.main-nav')) {
      if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
  });
  for (const name of ['practice', 'send', 'journey', 'lab']) $(`view-${name}`).hidden = name !== view;
  queueKeyboardLayout();
}

function renderControls() {
  const settings = { ...profile().settings, recallSeconds: responseGoal(profile()) };
  const stage = isGrowingCourse(settings) ? courseStage(settings.courseLevel) : null;
  $('lab-course').min = stage?.audioAlphabet ? '2' : '4';
  $$('[data-setting]').forEach(control => {
    const key = control.dataset.setting;
    if (key === 'kochCount') control.max = KOCH.length;
    if (control.type === 'checkbox') control.checked = settings[key];
    else if (document.activeElement !== control || control.type === 'range') control.value = settings[key];
    if (control.type === 'range') {
      control.setAttribute('aria-valuetext', `${control.value}${['wpm', 'farnsworth'].includes(key) ? ' words per minute' : key === 'tone' ? ' hertz' : ['rise', 'fall'].includes(key) ? ' milliseconds' : key === 'volume' ? ' percent' : key === 'recallSeconds' ? ' seconds per character' : ''}`);
    }
  });
  $$('[data-value]').forEach(output => { output.textContent = settings[output.dataset.value]; });
  $('send-speed-hint').textContent = settings.farnsworth > settings.wpm
    ? `Standard spacing at ${settings.wpm} WPM is in use. Your spacing setting is ${settings.farnsworth} WPM.`
    : 'Lower the spacing speed for longer gaps between letters and words.';
  $('summary-wpm').textContent = `${settings.wpm} WPM`;
  $('summary-farnsworth').textContent = settings.farnsworth >= settings.wpm ? 'Standard spacing' : `${settings.farnsworth} Farnsworth`;
  $('summary-tone').textContent = `${settings.tone} Hz`;
  $('lesson-name').textContent = isEndless(settings) ? 'Endless radio' : LESSONS.find(lesson => lesson.id === settings.lesson).name;
  $('course-control').hidden = settings.lesson !== 'starter' || isEndless(settings) || stage?.audioCourse && !stage.audioAlphabet;
  $('course-plan').textContent = isGrowingCourse(settings) ? '400 levels. Learn letters, short CW phrases and digits through 148; punctuation and radio signals at 149–192. Rebuild the alphabet by ear at 193–292, then digits and symbols at 293–372, with short refreshers between blocks. Levels 373–400 build from short groups to radio messages. Choose any level below.' : 'Automatic letters use Random groups. Other materials keep the alphabet you choose here.';
  $('course-level-control').hidden = !isGrowingCourse(settings);
  $('free-level-control').hidden = isGrowingCourse(settings) || isEndless(settings);
  $('track-control').hidden = settings.lesson !== 'starter' || settings.content !== 'groups';
  $('lab-track').querySelector('option[value="endless"]').disabled = !profile().endless.unlocked;
  $('endless-lock').hidden = profile().endless.unlocked;
  $('koch-control').hidden = settings.lesson !== 'koch';
  $('custom-control').hidden = settings.lesson !== 'custom';
  $('lesson-detail').textContent = isEndless(settings) ? 'Five messages per simulated contact. Correct copies earn Paragon XP.' : LESSONS.find(lesson => lesson.id === settings.lesson).detail;
  const sounds = [...alphabetFor(settings), ...(isGrowingCourse(settings) || isEndless(settings) ? courseStage(settings.courseLevel).prosigns || [] : [])];
  $('lesson-characters').innerHTML = characterChips(sounds);
  $('hint-characters').innerHTML = characterChips(sounds);
  $('lab-content').querySelector('option[value="groups"]').textContent = isEndless(settings) ? 'Radio exchanges' : isGrowingCourse(settings) && settings.courseLevel >= 94 ? 'Course exercises' : 'Random groups';
  const candidates = candidatesFor(settings);
  $('lesson-availability').textContent = candidates && !candidates.length ? emptyCopy() : candidates ? `${candidates.length} matching ${settings.content === 'words' ? 'word' : 'signal'}${candidates.length === 1 ? '' : 's'} in this mix.` : '';
  $$('[data-envelope]').forEach(button => {
    const ms = { crisp: 2, balanced: 5, soft: 10 }[button.dataset.envelope];
    button.setAttribute('aria-pressed', String(settings.rise === ms && settings.fall === ms && settings.curve === 'smooth'));
  });
  const duration = 1.2 / settings.wpm;
  const points = Array.from({ length: 161 }, (_, i) => {
    const x = 20 + i / 160 * 380;
    const y = 125 - envelopeAt(i / 160 * duration, duration, settings.rise, settings.fall, settings.curve) * 100;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  $('envelope-line').setAttribute('d', points);
  $('envelope-fill').setAttribute('d', `${points} L400,125 L20,125 Z`);
}

function emptyCopy() {
  const settings = profile().settings;
  if (settings.content === 'callsigns') return `No ${settings.level}-character callsigns match this alphabet. Try Letters + numbers and level 4 or 5, or choose Random groups.`;
  if (settings.content === 'phrases') return `No ${settings.level}-character phrases match this alphabet. Try The alphabet and level 7 or 8, or choose Random groups.`;
  return `No ${settings.level}-letter words match this alphabet. Try The alphabet, another length, or Random groups.`;
}

function renderAudioState() {
  const practicePlaying = playing && ['round', 'celebration', 'review'].includes(playingKind);
  $('receiver-stage').classList.toggle('is-playing', practicePlaying);
  $('receiver-stage').classList.toggle('is-celebrating', celebrating);
  const round = profile().round;
  const salute = saluteForId(round?.saluteId, profile().settings);
  $('audio-status').innerHTML = `<span class="live-dot"></span> ${celebrating ? `Completion signal · ${escape(salute.label)}` : playingKind === 'review' ? 'Review the sound with the pattern' : playing && playingKind === 'round' ? round?.introduction ? `New character: ${round.target}` : 'Signal on air' : round?.completed ? 'Copy complete' : round?.heard ? 'Your turn to copy' : round?.introduction ? `New character: ${round.target}` : 'Press Play to listen'}`;
  $('mastery-celebration').hidden = !celebrating;
  $('celebration-title').textContent = round?.byEarComplete ? 'Copied by ear' : round?.focusComplete ? 'Focus level complete' : isEndless(profile().settings) ? `Paragon ${profile().endless.rank}` : `Level ${levelNumber(profile().settings)} mastered`;
  $('celebration-code').textContent = salute.label;
  $('celebration-meaning').textContent = salute.meaning;
  $('celebration-next').textContent = round?.byEarComplete || round?.focusComplete ? `Back to level ${profile().settings.courseLevel}` : nextStepCopy(nextPracticeStep(profile()));
  document.querySelector('.signal-center use').setAttribute('href', celebrating ? '#i-spark' : '#i-headphones');
  const play = $('play-signal');
  const stopping = practicePlaying || nextSignalTimer !== null;
  const label = stopping ? 'Pause practice' : round?.completed ? 'Continue practice' : round?.plays ? 'Replay signal' : 'Play signal';
  const shortLabel = stopping ? 'Pause' : round?.completed ? 'Continue' : round?.plays ? 'Replay' : 'Play';
  const shortcut = stopping ? profile().focus?.active ? '' : 'Esc' : 'Enter';
  play.innerHTML = `${icon(stopping ? 'stop' : round?.plays && !round.completed ? 'repeat' : 'play')}<span class="replay-copy"><span class="replay-label">${label}</span><span class="replay-label-short">${shortLabel}</span>${shortcut ? `<kbd class="replay-shortcut" aria-hidden="true">${shortcut}</kbd>` : ''}</span>`;
  play.setAttribute('aria-label', label);
  if (shortcut) play.setAttribute('aria-keyshortcuts', stopping ? 'Escape' : 'Enter');
  else play.removeAttribute('aria-keyshortcuts');
  play.disabled = !round;
  $('lab-test').innerHTML = `${icon(playing && playingKind === 'preview' ? 'stop' : 'play')}${playing && playingKind === 'preview' ? 'Stop preview' : 'Preview “PARIS”'}`;
  $('preview-status').textContent = playing && playingKind === 'preview' ? 'On air…' : '';
  renderMorseVisibility();
  $$('[data-character]').forEach(button => button.classList.toggle('is-auditioning', playing && button.dataset.character === auditionCharacter));
  $$('[data-guidance-character]').forEach(button => button.classList.toggle('is-auditioning', playing && playingKind === 'guidance' && button.dataset.guidanceCharacter === auditionCharacter));
  $$('[data-course-example]').forEach(button => button.classList.toggle('is-auditioning', playing && playingKind === 'example' && button.dataset.courseExample === auditionCharacter));
  renderGuidanceProgress();
}

function renderLetterFeedback(result, reveal = false) {
  if (!result) { $('letter-feedback').hidden = true; return; }
  $('letter-feedback').innerHTML = result.letters.map(entry => {
    const text = reveal ? entry.expected || entry.actual : entry.actual || '?';
    const status = entry.correct || reveal ? 'correct' : '';
    return `<span class="letter-tile ${status}${text === ' ' ? ' space' : ''}" aria-label="${escape(text === ' ' ? 'space' : text)}: ${entry.correct || reveal ? 'correct' : entry.actual ? 'try again' : 'missing'}">${escape(text === ' ' ? '·' : text)}</span>`;
  }).join('');
  $('letter-feedback').hidden = false;
}

function renderCopyPace() {
  const p = profile();
  const round = p.round;
  const goal = responseGoal(p);
  const limit = goal * 1000;
  const responses = copyResponses(round);
  const measured = measuredResponse;
  const headCopy = measured(round?.headCopyMs);
  const corrected = round?.plays === 1 && round?.mistakes?.some(Boolean);
  const adaptive = p.settings.timingMode !== 'fixed';
  const times = responses.filter(measured);
  const slowest = times.length ? Math.max(...times) : null;
  const seconds = ms => `${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)}s`;
  let pace = 'ready';
  let label = `${adaptive ? 'Auto' : 'Goal'} ${goal}s`;
  let description = `${adaptive ? 'Adaptive' : 'Fixed'} goal: type each letter within ${goal}s of its last beep, or head-copy the whole group and finish within ${goal}s × its length after the last beep.`;
  let symbol = 'clock';
  if (corrected || round?.assisted || round?.plays > 1 || round?.attempts > 1 || round?.completed && !round.clean) {
    pace = 'practice';
    label = 'Practice copy';
    description = corrected ? 'Corrected letters appear in amber and are saved for review. Quick-copy readiness is measured before corrections.' : 'Assisted copies help you learn; quick-copy readiness is measured on the first listen.';
  } else if (slowest !== null && slowest > limit) {
    pace = 'slow';
    label = `Slower · ${seconds(slowest)}`;
    description = headCopy ? `Head-copy entry took ${seconds(round.headCopyMs * round.target.replaceAll(' ', '').length)} after the group. Your allowance is ${goal}s × its length.` : `Correct entry took up to ${seconds(slowest)} per letter. The goal is ${goal}s per letter.`;
  } else if (times.length && times.length === responses.length) {
    pace = 'quick';
    symbol = 'check';
    label = round?.completed ? `Quick · ${seconds(slowest)}` : 'Quick so far';
    description = headCopy ? `Head-copy within the group allowance: ${goal}s × ${round.target.replaceAll(' ', '').length} letters, starting at the final beep ending.` : `${times.length} letter${times.length === 1 ? '' : 's'} within the ${goal}s goal; slowest response ${seconds(slowest)}.`;
  } else if (round?.completed) {
    pace = 'unmeasured';
    label = 'Not timed';
    description = 'This copy has no complete response timing. Type along after each sound, or listen to the whole group and then type it.';
  }
  if (round?.byEar) {
    const independent = round.completed && round.clean && !round.visualUsed;
    pace = independent ? 'quick' : round.assisted || round.visualUsed || corrected ? 'practice' : 'ready';
    label = independent ? 'Copied by ear' : pace === 'practice' ? 'Guided copy' : 'Accuracy goal';
    symbol = independent ? 'check' : 'headphones';
    description = 'Six accurate letters on the first listen and try, with no visual help, and a clean final answer finish this checkpoint. No speed requirement; speed bonuses are optional. Timing controls below apply to normal course mastery.';
  }
  if (round?.focus) {
    pace = round.completed && round.clean ? 'quick' : round.assisted || corrected ? 'practice' : 'ready';
    label = pace === 'quick' ? 'Clean copy' : pace === 'practice' ? 'Practice copy' : 'Accuracy goal';
    symbol = pace === 'quick' ? 'check' : 'headphones';
    description = 'Two accurate singles per sound, then two clean pairs and triples where taught. This exercise has no speed requirement. Timing controls apply to normal course mastery.';
  }
  const badge = $('copy-pace');
  badge.dataset.pace = pace;
  badge.innerHTML = `${icon(symbol, true)}<span>${label}</span>${icon('down', true)}`;
  badge.title = `${description} Open response timing in Settings.`;
  badge.setAttribute('aria-label', `${label}. Adjust response timing. Current goal ${goal} seconds per letter. ${adaptive ? 'Adaptive' : 'Fixed'} mode.`);
  $$('[data-value="recallSeconds"]').forEach(output => { output.textContent = goal; });
  $$('[data-timing-description]').forEach(output => { output.textContent = adaptive ? 'Adjusts after every four accurate first-listen answers. Uses your recent response times. Moving the slider switches to Fixed.' : 'Your chosen window stays fixed. Type along, or head-copy the whole group before typing.'; });
  document.querySelector('.copy-area').dataset.pace = pace;
  if (morseTrace?.round === round) {
    const feedback = copyFeedback(round);
    morseTrace.groups.forEach((group, index) => {
      const start = Number(group.dataset.responseIndex);
      const count = Number(group.dataset.responseCount);
      const samples = feedback.slice(start, start + count);
      const correct = samples.length === count && samples.every(sample => sample.correct);
      const ms = correct && samples.every(sample => measured(sample.ms)) ? Math.max(...samples.map(sample => sample.ms)) : null;
      const timed = measured(ms);
      group.classList.toggle('is-quick', timed && ms <= limit);
      group.classList.toggle('is-slow', timed && ms > limit);
      group.classList.toggle('is-copied', correct && !timed);
      group.title = timed ? `Character ${index + 1}: ${ms <= limit ? 'quick' : 'slower'} · ${seconds(ms)} / ${goal}s goal${headCopy ? ' · head-copy average' : ''}` : correct ? `Character ${index + 1}: ${samples.some(sample => sample.corrected) ? 'corrected · practice copy' : 'correct · not timed; no quick-copy credit'}` : '';
    });
  }
}

function renderPractice() {
  const p = profile();
  const settings = p.settings;
  const round = p.round;
  const focused = round?.focus && p.focus?.active;
  const listening = round?.byEar && activeListening(p);
  $('receiver-stage').classList.toggle('is-by-ear', !!listening);
  document.querySelector('.receiver').dataset.listening = String(!!listening);
  const mission = isEndless(settings) ? radioMission(p.endless) : null;
  const stage = isGrowingCourse(settings) ? courseStage(settings.courseLevel) : null;
  $('learn-label').textContent = stage?.audioCourse ? 'Reference' : stage?.legacyLevel >= 153 && stage.legacyLevel <= 196 ? 'Learn symbols' : stage?.kind === 'frequencies' ? 'Learn frequencies' : stage?.shortCopies ? 'Lesson reference' : stage?.catalogue ? 'Learn phrases' : 'Learn letters';
  $('receiver-stage').dataset.track = isEndless(settings) ? 'endless' : 'course';
  $('practice-instruction').hidden = !mission;
  $('practice-instruction').textContent = mission ? `${mission.call} · ${mission.number}/${mission.total} · ${mission.label}` : '';
  $('empty-practice').hidden = Boolean(round);
  $('receiver-stage').hidden = !round;
  document.querySelector('.copy-area').hidden = !round;
  $('empty-copy').textContent = emptyCopy();
  const tally = stage?.audioNumbers ? `${stage.digits.length}/10 digits · by ear` : `${settings.courseCount}/26 letters${alphabetFor(settings).length > settings.courseCount ? ` + ${alphabetFor(settings).length - settings.courseCount} symbols` : ''}${stage?.audioCourse ? ' · by ear' : ''}`;
  $('signal-level').innerHTML = listening ? `By ear · ${listening.letters}/${LISTENING_GOAL} letters<span class="course-tally"> · after level ${listening.level}</span>` : focused ? `Focus · ${escape([...focused.sounds].join(' '))}<span class="course-tally">then level ${settings.courseLevel}</span>` : isEndless(settings) ? `Paragon ${p.endless.rank}` : `Level ${levelNumber(settings)}${isGrowingCourse(settings) ? `<span class="course-tally">/${COURSE_LEVELS} · ${tally}</span>` : ''}`;
  $('return-course').hidden = !focused && !listening;
  $('return-course').textContent = listening ? listening.maintenance ? 'Back to course' : 'Practice with help' : `Back to ${settings.courseLevel}`;
  $('return-course').setAttribute('aria-label', listening ? listening.maintenance ? 'Return to the numbered lesson. Refresher progress stays saved.' : 'Practice with visual help. Earned listening letters stay saved.' : `Back to level ${settings.courseLevel}`);
  if (focused) $('return-course').setAttribute('aria-keyshortcuts', 'Escape');
  else $('return-course').removeAttribute('aria-keyshortcuts');
  $('learn-letters').hidden = !!focused || !!listening && !listening.maintenance;
  $('skip-button').hidden = !!focused || !!listening;
  const answerLength = round?.target.replaceAll(' ', '').length || settings.level;
  $('answer-length').textContent = `${answerLength} character${answerLength === 1 ? '' : 's'}${settings.content === 'phrases' ? ' + spaces' : ''}`;
  const input = $('answer');
  input.inputMode = focused ? /^\d+$/.test(focused.sounds) ? 'numeric' : 'text' : !listening && (stage?.kind === 'frequencies' || stage?.audioNumbers) ? 'numeric' : 'text';
  const draft = round?.completed ? '' : round?.draft || '';
  if (input.value !== draft) input.value = draft;
  input.disabled = !round;
  $('round-result').hidden = !round?.completed;
  $('answer-form').hidden = false;
  $('hint-panel').hidden = !round?.hintOpen || round.completed;
  $('hint-button').setAttribute('aria-expanded', String(Boolean(round?.hintOpen && !round.completed)));
  $('skip-button').disabled = Boolean(round?.completed);
  $('hint-button').disabled = Boolean(round?.completed);
  $('answer-feedback').className = 'feedback';
  $('letter-feedback').hidden = true;
  $('feedback-placeholder').hidden = Boolean(round?.completed || round?.attempts);
  $('feedback-placeholder').textContent = listening ? 'First listen · accuracy goal' : guidedListeningPractice(p) ? `${p.listening.cooldown} guided letters before By ear returns` : 'Auto-check on';
  if (round?.completed) {
    const answer = escape(round.target);
    if (round.solved) {
      const next = nextPracticeStep(p);
      $('answer-feedback').textContent = celebrating ? isEndless(settings) ? `Paragon ${p.endless.rank} No answer needed.` : next?.addedCharacter ? `${next.addedCharacter} is next. No answer needed.` : `Level ${levelNumber(settings)} mastered No answer needed.` : round.clean && !round.quick ? settings.timingMode === 'adaptive' ? 'Correct. Timing recorded.' : 'Correct. Outside the time goal.' : nextSignalTimer !== null ? next ? nextStepCopy(next) : round.quick ? 'Quick copy. Next signal…' : 'Correct. Next signal…' : 'Correct. Press Enter for the next signal.';
      if (round.mistakes?.some(Boolean)) $('answer-feedback').textContent = `Corrected · ${[...new Set(round.mistakes.filter(Boolean).map(item => item.expected))].join(' ')} needs practice.`;
      else if (focused) $('answer-feedback').textContent = round.focusComplete ? `Focus complete Back to level ${settings.courseLevel}…` : 'Correct. Next signal…';
      $('answer-feedback').classList.add('success');
      if (round.clean && copyResponses(round).some(ms => ms !== null && ms > responseGoal(p) * 1000)) $('answer-feedback').classList.add('slower');
      $('result-copy').innerHTML = `<span class="answer-reveal">✓ ${answer}</span><span>· +${round.awarded} XP</span>${round.speedBonus ? `<span class="quick-bonus" aria-label="${round.speedBonus} quick-copy bonus">· +${round.speedBonus} quick</span>` : ''}`;
    } else {
      $('answer-feedback').textContent = 'Answer shown. Enter starts the next signal.';
      $('result-copy').innerHTML = `<span>The signal was</span><span class="answer-reveal">${answer}</span><span>· No points lost</span>`;
    }
  } else if (round?.attempts) {
    $('answer-feedback').textContent = round.attempts >= 3 ? 'Replay or use Help.' : 'Incorrect. Cleared; replaying.';
    $('answer-feedback').classList.add('incorrect');
    renderLetterFeedback(gradeAnswer(round.target, round.lastGuess ?? round.firstGuess ?? round.draft));
  } else {
    $('answer-feedback').textContent = round?.introduction ? `New ${/^[A-Z]$/.test(round.target) ? 'letter' : 'sound'} ${round.target}. Listen, then type ${round.target}.` : round?.heard ? 'Type what you hear.' : 'Press Play once, then listen and type.';
  }
  if (listening) {
    $('answer-feedback').textContent = round.completed ? round.byEarComplete ? 'Six letters copied by ear. Back to your course…' : round.byEarDeferred ? listening.maintenance ? 'Refresher paused. Back to course practice. Progress saved.' : 'Guided practice before the next attempt. Progress saved.' : round.solved ? round.clean && !round.visualUsed ? 'Copied by ear. Next signal…' : 'Assisted copy. Next signal…' : 'Review the pattern. Next signal…' : 'Copy by ear. Accuracy goal; no time limit.';
  }
  const streak = dayStreak(p.stats);
  $('streak-number').textContent = streak ? `${streak}-day listening streak` : 'No streak';
  $('streak-caption').textContent = 'Consecutive practice days';
  const count = p.stats.days[localDay()] || 0;
  $('daily-count').innerHTML = `${count}<span> / ${settings.goal}</span>`;
  $('daily-progress').setAttribute('aria-valuemax', settings.goal);
  $('daily-progress').setAttribute('aria-valuenow', Math.min(count, settings.goal));
  $('daily-progress').setAttribute('aria-valuetext', `${count} of ${settings.goal} signals copied today`);
  $('daily-progress').firstElementChild.style.width = `${Math.min(100, count / settings.goal * 100)}%`;
  $('daily-message').textContent = count >= settings.goal ? 'Daily goal reached.' : `${settings.goal - count} more to reach today’s goal.`;
  $('xp-count').textContent = `${p.stats.xp.toLocaleString()} XP`;
  renderPath();
  renderAudioState();
  renderCopyPace();
}

function renderPath() {
  const p = profile();
  const listening = activeListening(p);
  $('mastery-info').hidden = false;
  $('mastery-info').disabled = !!listening || focusCardOpen();
  $('mastery-dots').dataset.count = listening ? String(LISTENING_GOAL) : '20';
  $('mastery-copy').setAttribute('aria-live', listening ? 'polite' : 'off');
  $('mastery-copy').setAttribute('aria-atomic', 'true');
  if (listening) {
    $('path-title').textContent = listening.maintenance ? listening.label : 'By ear checkpoint';
    $('mastery-copy').textContent = listening.letters === LISTENING_GOAL && !listening.passed ? '6/6 letters · one clean copy to finish' : `${listening.letters}/${LISTENING_GOAL} letters copied by ear`;
    $('mastery-copy').title = 'Six correct letters on the first listen and try, with no visual help, and a clean final answer. Each accurate letter counts, even in a partly incorrect group; joined signals must be completely correct. There is no speed requirement. Earned letters stay saved.';
    $('mastery-info').setAttribute('aria-label', `${$('mastery-copy').textContent}. ${$('mastery-copy').title}`);
    $('mastery-info').title = $('mastery-copy').title;
    $('mastery-dots').innerHTML = Array.from({ length: LISTENING_GOAL }, (_, i) => `<i${i < listening.letters ? ' class="good"' : ''}></i>`).join('');
    $('level-path').hidden = true;
    return;
  }
  if (p.focus?.active) {
    const active = p.focus.active, { goal, done, phase } = focusProgress(active);
    $('focus-practice').style.setProperty('--focus-goal', goal);
    $('path-title').textContent = `Focus on ${[...active.sounds].join(' · ')}`;
    $('mastery-copy').textContent = `${done}/${goal} correct letters · ${['Complete', 'Singles', 'Pairs', 'Triples'][phase]}`;
    $('mastery-copy').title = 'Two correct singles per sound, then two clean pairs and two clean triples where taught. Accuracy counts; there is no speed gate.';
    $('mastery-info').setAttribute('aria-label', `${$('mastery-copy').textContent}. How this focus level works.`);
    $('mastery-info').title = 'How this focus level works';
    $('mastery-dots').innerHTML = Array.from({ length: goal }, (_, i) => `<i${i < done ? ' class="good"' : ''}></i>`).join('');
    $('level-path').hidden = true;
    return;
  }
  if (isEndless(p.settings)) {
    $('path-title').textContent = 'Endless radio';
    $('mastery-copy').textContent = `${p.endless.xp}/${rankGoal(p.endless.rank)} XP · ${p.endless.contacts} contacts`;
    $('mastery-info').setAttribute('aria-label', `${$('mastery-copy').textContent}. Paragon progression.`);
    $('mastery-info').title = 'Correct copies earn Paragon XP; a contact contains five messages.';
    $('mastery-dots').innerHTML = Array.from({ length: 20 }, (_, index) => `<i${index < p.endless.xp / rankGoal(p.endless.rank) * 20 ? ' class="good"' : ''}></i>`).join('');
    $('level-path').replaceChildren();
    $('level-path').hidden = true;
    return;
  }
  $('level-path').hidden = false;
  const growing = isGrowingCourse(p.settings);
  const level = levelNumber(p.settings);
  const maximum = growing ? COURSE_LEVELS : 10;
  const start = growing ? Math.max(1, Math.min(maximum - 9, level - 4)) : 1;
  $('path-title').textContent = growing ? 'Course progress' : 'Length progress';
  $('level-path').setAttribute('aria-label', growing ? `Choose course level; all ${COURSE_LEVELS} are available in Settings` : 'Choose answer length');
  $('level-path').innerHTML = Array.from({ length: 10 }, (_, index) => {
    const number = start + index;
    const settings = growing ? sanitizeSettings({ ...p.settings, courseLevel: number }) : { ...p.settings, level: number };
    const mastered = p.stats.mastery[practiceKey(settings)]?.mastered === true;
    const label = growing ? `${courseStage(number).label}, ${settings.courseCount} letters` : `${number} character${number === 1 ? '' : 's'}`;
    return `<button type="button" class="level-stop${level === number ? ' current' : ''}${mastered && number !== level ? ' mastered' : ''}" data-level="${number}" aria-label="Level ${number}: ${label}${mastered ? ', mastered' : ''}"${level === number ? ' aria-current="step"' : ''}><span>${mastered && level !== number ? icon('check', true) : number}</span></button>`;
  }).join('');
  const mastery = masteryFor(p);
  const next = nextPracticeStep(p);
  let masteryCopy = `${Math.min(mastery.good, 18)}/18 quick · ${mastery.total}/20 letters`;
  if (mastery.windowReady && mastery.focusReady && !mastery.copiesReady) masteryCopy = `${mastery.cleanCopies}/${mastery.requiredCopies} different quick, clean copies`;
  if (mastery.windowReady && mastery.focusReady && !mastery.coverageReady) masteryCopy = `${mastery.requiredSounds.length - mastery.missingSounds.length}/${mastery.requiredSounds.length} review sounds · next ${mastery.missingSounds[0]}`;
  if (mastery.windowReady && !mastery.focusReady) masteryCopy = `${mastery.focusCharacter} · ${mastery.focusGood}/${COURSE_FOCUS_COPIES} quick copies to move on`;
  if (mastery.mastered) masteryCopy = next?.addedCharacter ? `Mastered. ${next.addedCharacter} is next.` : level === maximum ? growing ? `All ${COURSE_LEVELS} levels mastered.` : 'Level 10 mastered' : next ? `Mastered. Level ${next.courseLevel ?? next.level} is next.` : p.round?.quick ? 'Mastered. Try another lesson.' : 'One quick copy to move on.';
  if (mastery.mastered && listeningComesNext(next)) masteryCopy = `Mastered. Six letters by ear, then level ${next.courseLevel}.`;
  $('mastery-copy').textContent = masteryCopy;
  $('mastery-copy').title = `Each dot is one letter guess. Mastery needs 18 quick, correct letters in the last 20, and a quick, clean final answer.${mastery.focusCharacter ? ` The latest ${COURSE_FOCUS_COPIES} copies of ${mastery.focusCharacter} at this length must also be quick and correct.` : ''}${mastery.requiredSounds.length ? ` Review sounds: ${mastery.requiredSounds.join(', ')}. Each needs a quick, correct copy in this level.` : ''}`;
  $('mastery-info').setAttribute('aria-label', `${masteryCopy}. How you level up.`);
  $('mastery-info').title = 'How you level up: timing and current requirements';
  $('mastery-dots').innerHTML = Array.from({ length: 20 }, (_, index) => `<i${index < mastery.total ? ` class="${mastery.history[index] ? 'good' : 'missed'}"` : ''}></i>`).join('');
  if ($('mastery-dialog').open) renderMasteryExplanation();
}

function renderMasteryExplanation() {
  const p = profile();
  const mastery = masteryFor(p);
  const goal = responseGoal(p);
  const length = p.round?.target.replaceAll(' ', '').length || p.settings.level;
  $('mastery-timing-mode').textContent = `${p.settings.timingMode === 'fixed' ? 'Fixed' : 'Adaptive'} · ${goal}s per letter`;
  $('mastery-along-example').textContent = `${goal}s after each letter ends`;
  $('mastery-head-example').textContent = `${Number((goal * length).toFixed(1))}s after the whole group ends (${length} ${length === 1 ? 'letter' : 'letters'})`;
  $('mastery-along-example').parentElement.hidden = p.settings.copyMode === 'head';
  document.querySelector('.timing-example').setAttribute('aria-label', p.settings.copyMode === 'head' ? 'Head-copy timing' : 'Two ways to copy');
  $('mastery-timing-description').textContent = p.settings.timingMode === 'fixed' ? 'Your window stays at the value you chose. You can turn Adaptive on by tapping the time badge.' : 'Your latest accurate first-listen answers set the window, from 0.5–4s per letter. It adjusts every four clean answers, allowing more time when needed and tightening by at most 0.1s at a time. Accuracy still decides progression.';
  const finishReady = !!(p.round?.solved && p.round.quick);
  $('mastery-window-count').textContent = `${mastery.total}/20`;
  $('mastery-quick-count').textContent = `${Math.min(mastery.good, 18)}/18`;
  $('mastery-window-rule').classList.toggle('is-ready', mastery.total === 20);
  $('mastery-quick-rule').classList.toggle('is-ready', mastery.good >= 18);
  $('mastery-focus-rule').hidden = !mastery.focusCharacter;
  $('mastery-focus-label').textContent = `New sound ${mastery.focusCharacter} · ${mastery.focusGood}/${COURSE_FOCUS_COPIES} quick`;
  $('mastery-focus-description').textContent = `The latest ${COURSE_FOCUS_COPIES} copies of ${mastery.focusCharacter} at this answer length must all be quick and correct.`;
  $('mastery-focus-rule').classList.toggle('is-ready', mastery.focusReady);
  $('mastery-messages-rule').hidden = !mastery.requiredCopies;
  $('mastery-messages-count').textContent = `${mastery.cleanCopies}/${mastery.requiredCopies}`;
  $('mastery-messages-rule').classList.toggle('is-ready', mastery.copiesReady);
  $('mastery-review-rule').hidden = !mastery.requiredSounds.length;
  $('mastery-review-count').textContent = `${mastery.requiredSounds.length - mastery.missingSounds.length}/${mastery.requiredSounds.length}`;
  $('mastery-review-description').textContent = mastery.missingSounds.length ? `Still to copy correctly within your goal: ${mastery.missingSounds.join(', ')}.` : 'Every required review sound has a quick, correct copy in this level.';
  $('mastery-review-rule').classList.toggle('is-ready', mastery.coverageReady);
  $('mastery-finish-rule').classList.toggle('is-ready', finishReady);
  $('mastery-finish-count').textContent = finishReady ? 'Done' : 'Needed';
}

function weakCharacters() {
  return practiceNeeds(profile().review);
}

function renderJourney() {
  const p = profile();
  const checkpoint = activeListening(p);
  const taught = checkpoint ? checkpointSettings(p.settings, checkpoint.level) : p.settings;
  const signs = isGrowingCourse(taught) || isEndless(taught) ? courseStage(taught.courseLevel).prosigns || [] : [];
  const sounds = [...alphabetFor(taught), ...signs];
  const phases = sounds.map(sound => ({ sound, phase: visualHelpPhase(p.review, sound, signs) }));
  const completed = Object.entries(p.listening.records).filter(([id, record]) => id.startsWith(`${p.settings.copyMode}:`) && record.passed).length;
  $('listening-summary').textContent = `${completed} checkpoint${completed === 1 ? '' : 's'} complete · ${phases.filter(entry => entry.phase === 'request').length}/${sounds.length} sounds ready without the pattern`;
  $('listening-confidence').innerHTML = phases.map(({ sound, phase }) => `<span class="confidence-sound" data-phase="${phase}" title="${escape(sound)}: ${phase === 'live' ? 'Learn with the pattern' : phase === 'review' ? 'Pattern after your answer' : 'Pattern only when requested'}"><strong>${escape(sound.length > 1 ? `<${sound}>` : sound)}</strong><small>${phase === 'live' ? 'Learn' : phase === 'review' ? 'Review' : 'By ear'}</small></span>`).join('');
  const stats = p.stats;
  const badges = new Set([...collectedBadges(p), ...earnedSendBadges(p.sending)].map(b => b.id));
  const letters = alphabetFor(p.settings);
  $('course-journey').hidden = !isGrowingCourse(p.settings);
  $('course-title').textContent = p.settings.courseLevel >= 101 ? 'Learned characters' : 'Learned characters';
  const stage = courseStage(p.settings.courseLevel);
  $('course-count').textContent = stage.audioNumbers ? `${stage.digits.length}/10 digits by ear` : `${p.settings.courseCount}/26 letters${letters.length > p.settings.courseCount ? ` + ${letters.length - p.settings.courseCount} symbols` : ''}`;
  $('course-journey-copy').textContent = `Level ${p.settings.courseLevel}/${COURSE_LEVELS} · ${stage.label}. ${stage.audioCourse ? 'Patterns appear after each answer. Each added character starts with singles before longer groups.' : letters.length < COURSE_LETTERS.length ? `Next character: ${COURSE_LETTERS[letters.length]}, after singles, pairs, triples and mixed review. New characters start at singles; learned characters remain in the exercises.` : 'Learn radio symbols, rebuild the characters by ear, then copy longer radio messages.'}`;
  $('course-journey-letters').innerHTML = characterChips([...letters, ...(isGrowingCourse(p.settings) ? courseStage(p.settings.courseLevel).prosigns || [] : [])]);
  $('copying-styles').innerHTML = ['flexible', 'head'].map(mode => {
    const entry = stats.modes[mode];
    return `<div class="copying-style"><strong>${mode === 'head' ? 'Head-copy · listen first' : 'Flexible copying'}</strong><span>${entry.total ? `${entry.total} completed · ${Math.round(entry.clean / entry.total * 100)}% first-listen accuracy · ${entry.quick} quick copies · best ${entry.best} characters` : mode === 'head' ? 'Hear the whole signal, then type. No answers recorded yet.' : 'Type as you listen or after the signal. No answers recorded yet.'}</span></div>`;
  }).join('');
  const pairs = confusionPairs(p.review);
  $('confusion-pairs').hidden = !pairs.length;
  $('confusion-pairs').innerHTML = pairs.map(pair => `<span class="confusion-pair"><b>${escape(pair.sound)} → ${escape(pair.other)}</b><span>${pair.count} ${pair.count === 1 ? 'mix-up' : 'mix-ups'}</span></span>`).join('');
  $('radio-journey').hidden = !p.endless.unlocked;
  $('radio-journey-progress').textContent = `Paragon ${p.endless.rank} · ${p.endless.xp}/${rankGoal(p.endless.rank)} XP · ${p.endless.contacts} completed contacts`;
  const cards = [
    ['SIGNALS COPIED', stats.solved.toLocaleString(), `${stats.total.toLocaleString()} rounds of listening`],
    ['FIRST-LISTEN ACCURACY', stats.total ? `${Math.round(stats.clean / stats.total * 100)}%` : '—', 'Correct, first try, without help'],
    ['YOUR LISTENING STREAK', `${dayStreak(stats)} ${dayStreak(stats) === 1 ? 'day' : 'days'}`, `${stats.bestStreak} clean copies in your best run`],
    ['TOTAL XP', `${stats.xp.toLocaleString()} XP`, `${badges.size} of ${BADGES.length + SEND_BADGES.length} badges earned`],
  ];
  $('stats-grid').innerHTML = cards.map(([label, value, caption]) => `<article class="card stat-card"><span class="eyebrow">${label}</span><strong>${value}</strong><p>${caption}</p></article>`).join('');
  const days = Array.from({ length: 7 }, (_, index) => { const date = new Date(); date.setDate(date.getDate() - 6 + index); return { date, count: stats.days[localDay(date)] || 0 }; });
  const max = Math.max(5, ...days.map(d => d.count));
  $('weekly-chart').innerHTML = days.map(({ date, count }, index) => `<div class="week-day${index === 6 ? ' today' : ''}"><strong>${count}</strong><div class="week-bar" data-count="${count}"></div><span>${date.toLocaleDateString(undefined, { weekday: 'short' })}</span></div>`).join('');
  $$('#weekly-chart .week-bar').forEach(bar => { bar.style.height = `${Math.max(2, Number(bar.dataset.count) / max * 120)}px`; });
  $('weekly-chart').setAttribute('aria-label', days.map(({ date, count }) => `${date.toLocaleDateString(undefined, { weekday: 'long' })}: ${count} copied signals`).join('; '));
  const weak = weakCharacters();
  $('weak-characters').innerHTML = weak.length ? `<div class="weak-chips">${weak.map(([c, s]) => `<button type="button" class="weak-item" data-character="${escape(c)}" aria-label="Listen to ${escape(c)}, ${s.correct} of ${s.seen} recent first attempts correct"><strong>${escape(c.length > 1 ? `<${c}>` : c)}</strong><small>${Math.round(s.correct / s.seen * 100)}%</small><small>${s.correct}/${s.seen} correct</small></button>`).join('')}</div>` : '<p class="empty-note">No recent mistakes recorded.</p>';
  $('practice-weak').disabled = !weak.length;
  const badgeCard = badge => `<article class="card badge-card${badges.has(badge.id) ? ' earned' : ''}" data-badge="${badge.id}"><span class="badge-symbol">${icon(badge.icon)}</span><div><strong>${badge.title}</strong><p>${badge.description}</p><span class="badge-status">${badges.has(badge.id) ? 'EARNED' : 'NOT EARNED'}</span></div></article>`;
  $('badge-grid').innerHTML = BADGES.map(badgeCard).join('');
  $('send-badge-grid').innerHTML = SEND_BADGES.map(badgeCard).join('');
  const recent = practiceSessions(p).slice(0, 10);
  $('recent-sessions').innerHTML = recent.length ? `<table class="round-table session-table"><thead><tr><th scope="col">Started</th><th scope="col">Activity</th><th scope="col">Duration</th><th scope="col">Answers</th><th scope="col">Copied / clean sends</th></tr></thead><tbody>${recent.map(s => {
    const started = new Date(s.start).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `<tr><td>${escape(started)}</td><td>${s.activity}${s.partial ? ' (partial)' : ''}</td><td>${sessionDuration(s.duration)}</td><td>${s.answers.toLocaleString()}</td><td class="clean-label">${s.correct.toLocaleString()}</td></tr>`;
  }).join('')}</tbody></table>` : '<p class="empty-note">No practice sessions recorded.</p>';
}

function saveSharing(callsign, enabled) {
  const p = profile(), previous = { callsign: p.callsign, leaderboard: p.leaderboard };
  try {
    storage.atomic(() => { storage.consent(p, callsign, enabled); storage.setItem(STORAGE_KEY, JSON.stringify(state)); });
  } catch (error) {
    Object.assign(p, previous);
    throw error;
  }
  leaderboardUpdated = 0;
  deviceSync.consentChanged();
}
function renderSavedProgress() {
  const p = profile();
  $('progress-summary').textContent = `Listening: Level ${levelNumber(p.settings)} · Sending: Level ${p.sending.level}/${SENDING_LEVELS} · ${p.stats.xp.toLocaleString()} XP`;
  if (deviceSync) renderDeviceSync(deviceSync.status);
  const older = state.profiles.filter(saved => saved.id !== p.id);
  $('earlier-saves').hidden = !older.length;
  $('earlier-exports').replaceChildren(...older.map(saved => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button';
    button.textContent = `Export ${saved.callsign || saved.name} · ${saved.stats.xp.toLocaleString()} XP`;
    button.onclick = () => exportLearner(saved); return button;
  }));
  $('storage-note').textContent = window.morseMac ? 'Your progress is saved on this Mac. Export a copy to keep it elsewhere.' :
    'Your progress is saved in this browser. Export a copy before clearing site data.';
  const row = storage.row(p.id);
  const held = row.previousScores || [];
  $('previous-results').hidden = !held.length;
  if (held.length) {
    const xp = held.reduce((sum,r)=>sum+r.xp,0);
    $('previous-results-summary').textContent = held.length+' previously unsent results · '+xp.toLocaleString()+' XP for '+p.callsign+'. Public scores from earlier manual imports may overlap.';
    $('share-previous-results').disabled = !p.leaderboard || !p.callsign;
  }
  const h=row.history;
  $('legacy-scores').hidden=h?.decision!=='pending';
  if (h?.decision==='pending' && $('publish-history').hidden) $('legacy-score-summary').textContent=h.xp.toLocaleString()+' XP from the previous desktop app. This stays private until you confirm.';
  if (!identityDirty) {
    $('learner-callsign').value = p.callsign || '';
    $('list-on-leaderboard').checked = p.leaderboard || !p.callsign && !storage.row().foundation && !storage.row().choiceSet;
  }
}

async function refreshLeaderboard(force = false) {
  if (mac?.syncMode === 'staging') $('leaderboard-title').textContent = 'Local test leaderboard';
  if (mac?.syncMode === 'offline') {
    $('leaderboard-message').textContent = 'Offline practice';
    return;
  }
  if (!deviceSync || !force && Date.now() - leaderboardUpdated < 10000) return;
  if (leaderboardLoading) { leaderboardRefreshDue ||= force; return; }
  const owner = profile().id;
  leaderboardLoading = true;
  $('leaderboard-message').textContent = 'Loading…';
  try {
    const result = await deviceSync.request('leaderboard');
    if (profile().id !== owner) { leaderboardRefreshDue = true; return; }
    if (result.erased) { deviceSync.receive(result, deviceSync.meta()); return; }
    const p = profile(), callsign = p.callsign;
    const station = result.me?.callsign === callsign ? result.me : result.entries.find(entry => entry.callsign === callsign);
    $('leaderboard-rows').innerHTML = result.entries.map(entry => `<tr${entry.callsign === callsign ? ' class="leaderboard-self"' : ''}><td>${entry.rank}</td><th scope="row">${escape(entry.callsign)}</th><td>${entry.xp.toLocaleString()}</td><td><span class="leaderboard-streak" aria-label="${entry.streak}-day listening streak">${entry.streak}${entry.streak}<span aria-hidden="true">d</span></span></td></tr>`).join('');
    const pendingXP = storage.row(p.id).scores.reduce((sum, score) => sum + score.xp, 0);
    const comparison = station ? `${callsign} · #${station.rank} · ${station.xp.toLocaleString()} leaderboard XP` : `${callsign} · outside the displayed rankings`;
    const status = !p.leaderboard ? ' · Sharing off' : pendingXP ? ` · ${pendingXP.toLocaleString()} XP waiting to upload` : '';
    $('leaderboard-me').textContent = callsign ? `${comparison} · ${p.stats.xp.toLocaleString()} total XP${status}` : '';
    $('leaderboard-message').textContent = result.entries.length ? 'Top 50 stations' : 'No leaderboard entries yet.';
    leaderboardUpdated = Date.now();
  } catch { $('leaderboard-message').textContent = 'The leaderboard is offline. Your progress stays saved here.'; }
  finally {
    leaderboardLoading = false;
    const again = leaderboardRefreshDue;
    leaderboardRefreshDue = false;
    if (again && view === 'journey') void refreshLeaderboard(true);
  }
}

function clearMorseData() {
  stopPlayback({ save: false });
  sender?.connection.disconnect();
  sender?.pause();
  audio.release();
  cancelImport(); cancelProgressReset(); cancelAnswerFocus();
  guidanceContext = null;
  restorePracticeWorkspace();
  $$('dialog').filter(d => d.open).forEach(closeNativeDialog);
  const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(k => k?.startsWith('morse.'));
  for (const key of keys) storage.removeItem(key);
  document.cookie = `morse_learner=; Path=/; Max-Age=0; SameSite=Strict${location.protocol === 'https:' ? '; Secure' : ''}`;
  state = newState();
  identityDirty = false; pairingInvitation = null; pairingOffer = null;
  callsignIntroPending = true; callsignIntroBusy = false;
  rememberCallsignIntro();
  $('intro-callsign').value = ''; $('intro-callsign-message').textContent = '';
  $('intro-callsign').removeAttribute('aria-invalid');
  $('learner-callsign').value = ''; $('list-on-leaderboard').checked = false;
  $('pair-offer').hidden = true; $('pair-qr').replaceChildren(); $('pair-link').value = '';
  $('leaderboard-rows').replaceChildren(); $('leaderboard-me').textContent = ''; leaderboardUpdated = 0;
  $('delete-data-confirmation').hidden = true;
  composing = false;
  view = 'practice'; history.replaceState(null, '', '#practice');
  render(); persist();
  showLessonGuidance();
}

function renderDeviceSync(status) {
  const available = service.privateSync;
  const linkUnavailable = !available && (status.connected || !!deviceSync?.meta());
  $('private-sync').hidden = !available && !linkUnavailable;
  const syncMessage = linkUnavailable ? 'Website unavailable · saved on this device' : status.message;
  if ($('sync-status').textContent !== syncMessage) $('sync-status').textContent = syncMessage;
  const linked = available && status.connected && !status.waiting;
  $('station-recovery').disabled = !linked || recoveryBusy;
  $('pair-entry').hidden = !available;
  $('pair-devices').textContent = linked ? 'Pair another device' : 'Enable private sync';
  $('recovery-help').textContent = status.waiting ? 'Approve the pairing on your other device before generating a recovery code.' : linked ? 'Generate a code here and store it somewhere private. Generating a new code replaces the previous one.' :
    'Choose Enable private sync on the device that holds your progress, then choose Generate recovery code.';
  if (!linked) { $('recovery-issued').hidden = true; $('recovery-output').textContent = ''; }
  let description;
  if (linkUnavailable) description = 'Morse will check again when the website is available.';
  else if (linked && status.localPlaybackOnly) description = 'Your sending pause and “Wait for E” preference are currently saved on this device.';
  else if (linked) description = 'Only progress that has reached the website can be recovered.';
  else if (mac) description = 'On the website, open Saved progress, enable private sync, then choose Pair another device. Paste the link here and approve the matching code on the website.';
  else description = 'Enable private sync here, then choose Pair another device. Only progress that has reached the website can be recovered.';
  $('sync-description').textContent = description;
  if (deviceSync?.scoreError) $('callsign-message').textContent=deviceSync.scoreError;
  $('sync-status').dataset.error = String(!!status.error);
  const devices = status.devices || [];
  const deviceKey = JSON.stringify(status.connected ? devices : []);
  $('sync-devices').hidden = !status.connected;
  if (deviceKey !== pairingDevicesKey) {
    pairingDevicesKey = deviceKey;
    $('sync-devices').innerHTML = status.connected ? devices.map(d => `<li><span>${escape(d.label)}${d.current ? ' · this device' : ''}</span><button type="button" class="text-button" data-disconnect="${escape(d.id)}">Disconnect</button></li>`).join('') : '';
  }
  const claim = status.invite?.claim;
  $('pair-approval').hidden = !claim;
  $('pair-waiting').hidden = !status.waiting;
  if (status.waiting) $('pair-waiting-code').textContent = status.waiting.code;
  if (claim) {
    $('pair-request-title').textContent = `${status.invite.label} wants to connect`;
    $('pair-approval-code').textContent = status.invite.code;
    const mine = profile().stats.xp, theirs = status.invite.xp;
    $('pair-score-choice').textContent = `This device has ${mine} XP. The other has ${theirs} XP. Both original profiles are retained. New work is combined. Old counters without result IDs can overlap.`;
  }
  if (pairingOffer && (!status.invite || status.invite.expiresAt <= Date.now())) {
    pairingOffer = null;
    $('pair-offer').hidden = true;
    $('pair-qr').replaceChildren();
    $('pair-link').value = '';
  }
  $('pair-devices').hidden = !available || !!pairingOffer || !!claim || !!status.waiting || !!pairingInvitation;
  $('pair-incoming').hidden = !available || !pairingInvitation;
}

function deviceLabel() {
  return /iPhone/i.test(navigator.userAgent) ? 'iPhone' : /iPad/i.test(navigator.userAgent) || /Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1 ? 'iPad' : /Android/i.test(navigator.userAgent) ? 'Android' : /Macintosh/i.test(navigator.userAgent) ? 'Mac' : /Windows/i.test(navigator.userAgent) ? 'Computer' : 'Browser';
}

async function pairingAction(button, action) {
  if (button.disabled) return;
  button.disabled = true;
  $('pair-message').textContent = '';
  try { await action(); }
  catch (error) { $('pair-message').textContent = error.message || 'Could not connect. Local progress is saved. Try again.'; }
  finally { button.disabled = false; }
}

function showPairQr(link) {
  const qr = qrcode(0, 'M');
  qr.addData(link, 'Byte'); qr.make();
  const size = qr.getModuleCount(), ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `-4 -4 ${size + 8} ${size + 8}`);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  let data = '';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (qr.isDark(y, x)) data += `M${x},${y}h1v1h-1z`;
  path.setAttribute('d', data); path.setAttribute('fill', '#000');
  svg.append(path); $('pair-qr').replaceChildren(svg);
}

function localProfileWithSync(current, shared, replace) {
  const next = { ...shared, ...(current.previousTiming ? { previousTiming: current.previousTiming } : {}), leaderboard: current.leaderboard, callsign: current.callsign || shared.callsign, sending: { ...shared.sending, settings:{...shared.sending.settings,reverse:current.sending.settings.reverse} }, id: current.id, name: current.name, settings: { ...shared.settings, volume: current.settings.volume }, pacing: current.pacing, headPacing: current.headPacing,
    sessionId: replace ? '' : current.sessionId,
    listening: { ...shared.listening, active: !replace && practiceKey(shared.settings) === practiceKey(current.settings) ? current.listening.active : null, cooldown: replace ? 0 : current.listening.cooldown },
    focus: !replace && practiceKey(shared.settings) === practiceKey(current.settings) ? current.focus : sanitizeFocus(null, shared.settings) };
  const sameMission = JSON.stringify(shared.endless) === JSON.stringify(current.endless);
  next.round = !replace && practiceKey(next.settings) === practiceKey(current.settings) && (!isEndless(next.settings) || sameMission) ? current.round : null;
  return next;
}

function acceptSyncedProfile(shared, { replace = false } = {}) {
  const returning = callsignIntroPending && !callsignIntroBusy && (shared.callsign || shared.stats.total || shared.stats.xp || shared.guidance.welcomed);
  const intro = returning ? $('callsign-intro-dialog') : null;
  // A remembered device cookie may restore a returning learner even when the
  // browser's local save was removed. Keep that station's existing choice.
  if (returning) {
    callsignIntroPending = false;
    rememberCallsignIntro();
    if (intro.open) finishDialog(intro, { returnToPractice: false });
  }
  const current = profile();
  const next = localProfileWithSync(current,shared,replace);
  stopPlayback({ save: false });
  state.profiles = state.profiles.map(p => p.id === current.id ? next : p);
  cancelImport(); cancelProgressReset();
  persist(); render();
  if (!$$('dialog').some(d => d.open) && view === 'practice' && !showLessonGuidance()) focusAnswer({ select: next.round?.completed, fromDialog: intro });
}

function renderSoundChoice(native) {
  const p = profile(), options = previousSounds(p, acceptedSound ? null : native);
  const panel = $('sound-choice');
  panel.hidden = options.length < 2;
  const key = JSON.stringify([p.id, options, !!native]);
  if (key !== choicesKey) {
    choicesKey = key;
    $('sound-choices').replaceChildren(...options.map(({label, settings}) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'button secondary';
      const curve = settings.curve === 'smooth' ? 'raised cosine' : settings.curve;
      button.textContent = `Use ${label} · ${settings.wpm}/${settings.farnsworth} WPM · ${settings.tone} Hz · ${settings.volume}% · ${settings.rise}/${settings.fall} ms ${curve}`;
      button.onclick = () => {
        const p = profile();
        if (choicesKey !== key) return;
        const prior = p.settings, previousTiming = p.previousTiming;
        p.settings = sanitizeSettings({ ...prior, ...settings }); delete p.previousTiming;
        mirrorSendingSpeed(p);
        if (!persist()) {
          p.settings = prior; if (previousTiming) p.previousTiming = previousTiming;
          mirrorSendingSpeed(p); return;
        }
        acceptedSound = !!native; choicesKey = '';
        if (sender?.native) sender.migrationPending = !sender.connection.status;
        sender?.pause(); render();
      };
      return button;
    }));
  }
  return !panel.hidden;
}

function render() {
  if (sender) {
    const pending = renderSoundChoice(sender.connection?.status);
    if (sender.native && sender.connection?.status) sender.migrationPending = pending;
  }
  if (guidanceContext && (guidanceContext.learnerId !== profile().id || guidanceContext.key !== guidanceKey(profile().settings) || guidanceContext.focus && !profile().focus?.active)) finishLessonGuidance();
  ensureRound();
  renderHeader();
  renderControls();
  renderPractice();
  renderJourney();
  sender?.render();
  if ($('progress-dialog').open) renderSavedProgress();
}

function stopPlayback({ interrupted = false, save = true, pauseFlow = true } = {}) {
  rewards.clear();
  clearTimeout(nextSignalTimer);
  nextSignalTimer = null;
  if (pauseFlow) continuous = false;
  celebrating = false;
  copySession = null;
  clearMorseTrace();
  const wasPlaying = playing;
  const wasRound = playingKind === 'round';
  playbackId++;
  audio.stop();
  playing = false;
  playingKind = '';
  auditionCharacter = '';
  if (wasPlaying && wasRound && profile().round && !profile().round.completed) {
    profile().round.assisted = true;
    if (save) persist();
    if (interrupted) announce('Signal paused. Press Replay to continue.');
  }
  renderAudioState();
}

async function playSound(text, settings, kind, character = '') {
  stopPlayback({ pauseFlow: !['round', 'celebration', 'review'].includes(kind) });
  const checkpoint = activeListening(profile());
  if (checkpoint && ['round', 'review', 'guidance', 'example'].includes(kind)) settings = checkpointSettings(settings, checkpoint.level);
  const token = ++playbackId;
  const learnerId = profile().id;
  const soundGuidance = guidanceContext;
  const currentRound = profile().round;
  playing = true;
  playingKind = kind;
  celebrating = kind === 'celebration';
  auditionCharacter = character;
  if (celebrating) renderPractice();
  else renderAudioState();
  try {
    const spoken = kind === 'round' && currentRound?.focus ? text : kind === 'character' && Object.hasOwn(PROSIGNS, text) ? `<${text}>` : ['round', 'review', 'guidance', 'example'].includes(kind) ? transmissionText(text, settings) : text;
    const result = await audio.play(spoken, settings, { onSchedule(plan, startsAt, elapsed) {
      if (kind === 'round' && !currentRound.completed) {
        const session = createCopySession(plan, startsAt);
        session.text = normalizeText(currentRound.draft).replaceAll(' ', '');
        session.responses = Array(session.text.length).fill(null);
        // Each listen gets fresh visual timing. The submitted first-listen
        // measurements remain separate for mastery, review and speed bonuses.
        currentRound.responseTimes = [...session.responses];
        currentRound.headCopyMs = null;
        copySession = { round: currentRound, session };
      }
      if (view === 'practice') startMorseTrace(plan, elapsed);
    } });
    if (token !== playbackId || profile().id !== learnerId) return;
    if (result.completed) finishMorseTrace();
    playing = false;
    playingKind = '';
    auditionCharacter = '';
    if (kind === 'guidance' && result.completed && soundGuidance && guidanceContext === soundGuidance) {
      if (soundGuidance.recovery) {
        if (profile().round === soundGuidance.round && rememberRecoverySound(soundGuidance.round, character, soundGuidance.recoveryState)) {
          const next = recoveryCharacter(soundGuidance.round);
          if (!next) {
            soundGuidance.round.recovery = null;
            persist();
            finishLessonGuidance({ play: true });
            return;
          }
          persist();
          if (next !== character) {
            soundGuidance.characters = [next];
            $('guidance-title').textContent = `Review ${next}`;
            renderGuidanceCharacters();
          }
        }
      } else if (!soundGuidance.focus && rememberGuidanceSound(profile(), character, soundGuidance.key)) {
        persist();
        if (soundGuidance.repetitions) {
          const next = nextGuidanceCharacter(soundGuidance);
          if (!next) { finishLessonGuidance({ play: true }); return; }
          if (next !== character) renderGuidanceCharacters();
        }
      }
    }
    if (kind === 'round' && result.completed && profile().round === currentRound) {
      currentRound.heard = true;
      persist();
      renderPractice();
      settleAnswerFocus();
      checkTypedAnswer();
    } else if (kind === 'review' && result.completed && profile().round === currentRound) {
      if (continuous) scheduleNextSignal();
      renderPractice(); settleAnswerFocus();
    } else if (kind === 'celebration' && result.completed && profile().round === currentRound) {
      if (continuous) scheduleNextSignal();
      renderPractice();
    } else renderAudioState();
  } catch (error) {
    if (token !== playbackId) return;
    playing = false;
    playingKind = '';
    auditionCharacter = '';
    celebrating = false;
    clearMorseTrace();
    if (kind === 'celebration' && continuous) scheduleNextSignal();
    else continuous = false;
    renderPractice();
    announce(error.message || 'Could not play audio. Tap Play to try again.');
  }
}

function playRound({ slower = false } = {}) {
  if (playing && playingKind === 'round' && !slower) { stopPlayback(); focusAnswer(); return; }
  const p = profile();
  if (!p.round) return;
  if (recoveryCharacter(p.round)) { showLessonGuidance(); return; }
  continuous = true;
  p.round.plays++;
  if (p.round.plays > 1 || slower) p.round.assisted = true;
  persist();
  const checkpoint = activeListening(p);
  const taught = checkpoint ? checkpointSettings(p.settings, checkpoint.level) : p.settings;
  const settings = slower ? { ...taught, wpm: Math.max(5, Math.round(taught.wpm * 0.65)), farnsworth: Math.max(1, Math.min(taught.farnsworth, Math.round(taught.farnsworth * 0.65))) } : { ...taught };
  focusAnswer();
  playSound(p.round.target, settings, 'round');
}

function playOrPause() {
  if (nextSignalTimer !== null || playing && ['round', 'celebration', 'review'].includes(playingKind)) {
    stopPlayback();
    renderPractice();
    focusAnswer({ select: profile().round?.completed });
  } else if (profile().round?.completed) nextRound();
  else playRound();
}

function preview() {
  if (playing && playingKind === 'preview') { stopPlayback(); return; }
  playSound('PARIS', { ...profile().settings }, 'preview');
}

function openDialog(name) {
  cancelAnswerFocus();
  sender?.pause();
  dialogOpeners.set($(name), document.activeElement);
  stopPlayback();
  if (name === 'progress-dialog') {
    cancelImport();
    renderSavedProgress();
    cancelProgressReset();
    $('import-confirmation').hidden = true;
    $('progress-message').textContent = '';
    deviceSync?.schedule(0);
  }
  $(name).showModal();
}

function cancelImport() {
  importGeneration++;
  importController?.abort();
  importController = null;
  pendingImport = null;
  $('import-confirmation').hidden = true;
}

function cancelProgressReset() {
  pendingResetId = null;
  pendingResetScope = null;
  $('reset-progress-confirmation').hidden = true;
  $('reset-send-confirmation').hidden = true;
  $('delete-data-confirmation').hidden = true;
}

function markAssisted() {
  const round = profile().round;
  if (round && !round.completed) { round.assisted = true; persist(); }
}

function openChart() {
  markAssisted();
  if (!$('chart-content').children.length) {
    $('chart-content').innerHTML = [['The alphabet', LETTERS], ['Numbers', DIGITS], ['Punctuation', PUNCTUATION]].map(([title, characters]) => `<section class="chart-group"><h3>${title}</h3><div class="character-chips">${characterChips(characters)}</div></section>`).join('');
  }
  openDialog('chart-dialog');
}

function changeView(next, { lesson = false } = {}) {
  if (!['practice', 'send', 'journey', 'lab'].includes(next)) return;
  cancelAnswerFocus();
  sender?.pause();
  stopPlayback();
  view = next;
  history.replaceState(null, '', `#${next}`);
  render();
  if (next === 'journey') { void refreshService(); refreshLeaderboard(); }
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (next === 'lab' && !$('sound-choice').hidden) $('sound-choice').scrollIntoView({ block:'nearest' });
  if (lesson) {
    $('lesson-settings').scrollIntoView({ block: 'start', behavior: 'instant' });
    $('lab-lesson').focus({ preventScroll: true });
  } else if (next === 'practice' && !showLessonGuidance()) focusAnswer({ select: profile().round?.completed });
}

function changeSettings(updates) {
  stopPlayback();
  const p = profile();
  if (updates.track === 'endless' && !p.endless.unlocked) { announce(`Finish level ${COURSE_LEVELS} to unlock endless radio.`); return; }
  if (Object.hasOwn(updates, 'visualSupport')) updates = { ...updates, showMorse: updates.visualSupport !== 'off' };
  if (Object.hasOwn(updates, 'courseLevel') || Object.hasOwn(updates, 'courseCount')) updates = { ...updates, track: 'course' };
  const oldKey = practiceKey(p.settings);
  const previousSettings = p.settings;
  const previous = p.round?.target || '';
  const courseChanged = Object.hasOwn(updates, 'courseCount') && Number(updates.courseCount) !== p.settings.courseCount;
  // Moving the quick copy slider sets a manual goal. Keep that goal when the
  // learner switches back to Adaptive, which then calibrates on fresh answers.
  if (Object.hasOwn(updates, 'recallSeconds')) updates = { ...updates, timingMode: 'fixed' };
  if (updates.timingMode === 'adaptive' && p.settings.timingMode === 'fixed') p[p.settings.copyMode === 'head' ? 'headPacing' : 'pacing'] = sanitizePacing(null, p.settings.recallSeconds);
  const audioAlphabet = isGrowingCourse(p.settings) && courseStage(p.settings.courseLevel).audioAlphabet;
  p.settings = sanitizeSettings({ ...p.settings, ...updates, ...(courseChanged ? { courseLevel: audioAlphabet ? earCourseLevelFor(Number(updates.courseCount)) : courseLevelFor(Number(updates.courseCount), 1) } : {}) });
  mirrorSendingSpeed(p);
  if (sender?.busy && !sender.playing && soundFields.some(key => p.settings[key] !== previousSettings[key])) {
    sender.pauseInput('Sound settings changed. Send the answer again.');
  }
  const hadFocus = !!p.focus?.active;
  p.focus = sanitizeFocus(p.focus, p.settings);
  const hadListening = !!p.listening.active;
  p.listening = sanitizeListening(p.listening, p.settings);
  if (practiceKey(p.settings) !== oldKey || hadFocus && !p.focus.active || hadListening && !p.listening.active) {
    p.round = null;
    ensureRound(previous);
  } else if (p.round?.plays && !p.round.completed) p.round.assisted = true;
  persist();
  render();
  if (view === 'practice') showLessonGuidance();
}

function nextRound({ skipped = false, draft = '' } = {}) {
  stopPlayback();
  composing = false;
  const p = profile();
  const previous = p.round?.target || '';
  if (skipped && p.round && !p.round.completed) completeListening(p);
  const next = nextPracticeStep(p);
  const sourceLevel = p.settings.courseLevel;
  const leavingListening = p.round?.byEar && (p.round.byEarComplete || p.round.byEarDeferred);
  if (leavingListening) leaveListening(p);
  if (isEndless(p.settings) && p.round?.completed) nextRadioStep(p.endless);
  if (next) {
    p.settings = sanitizeSettings({ ...p.settings, ...next });
    queueListening(p, sourceLevel);
  } else if (p.focus?.active && !focusPhase(p.focus.active)) {
    endFocus(p);
  } else if (!p.round?.focus && !p.round?.byEar && !p.listening.active && (p.round?.firstGuess || p.round?.typedReviewed?.length) && (p.round.firstResponseTimes !== null || p.round.typedReviewed?.length) && (!gradeAnswer(p.round.target, p.round.firstGuess || '').correct || p.round.mistakes?.some(Boolean))) {
    beginFocus(p);
  }
  if (!p.focus?.active && !p.listening.active && !leavingListening) beginListening(p);
  p.round = null;
  ensureRound(previous);
  if (p.round) p.round.draft = next || p.round.focus || p.round.byEar ? '' : draft;
  if (guidanceContext?.focus && !p.focus?.active) finishLessonGuidance();
  persist();
  render();
  if (showLessonGuidance()) return;
  focusAnswer();
  if (p.round) playRound();
}

function checkAnswer(event) {
  event?.preventDefault();
  const p = profile();
  const round = p.round;
  if (!round) return;
  if (playingKind === 'review') { focusAnswer(); return; }
  if (recoveryCharacter(round)) { showLessonGuidance(); return; }
  if (round.completed) { nextRound(); return; }
  if (playing) { focusAnswer(); return; }
  if (!round.heard) { playRound(); return; }
  const answer = normalizeText($('answer').value);
  if (!answer) { playRound(); return; }
  round.draft = answer;
  if (round.firstGuess === null) round.firstResponseTimes = round.heard && round.plays === 1 && !round.assisted ? copyResponses(round) : null;
  round.attempts++;
  round.firstGuess ??= answer;
  recordFirstReview(p);
  round.lastGuess = answer;
  const result = gradeAnswer(round.target, answer);
  let celebrate = false;
  let earned = [];
  if (result.correct) {
    const finished = completeListening(p, { solved: true });
    earned = BADGES.filter(b => finished.badges.includes(b.id));
    continuous = true;
    celebrate = finished.byEarComplete || finished.focusComplete || finished.promoted || nextPracticeStep(p) !== null;
    if (celebrate) {
      const checkpoint = activeListening(p);
      const salute = chooseSalute(checkpoint ? checkpointSettings(p.settings, checkpoint.level) : p.settings, p.stats.lastSalute, { milestone: !checkpoint });
      round.saluteId = salute.id;
      p.stats.lastSalute = salute.id;
    }
    if (!celebrate) scheduleNextSignal();
  } else {
    recordSessionAnswer(p, { correct: false });
    round.draft = '';
    if (round.byEar) {
      completeListening(p);
      round.visualRevealed = true;
      continuous = true;
    } else if (!focusCardOpen()) beginRecovery(round, result, round.focus ? { ...p.settings, lesson: 'custom' } : p.settings);
  }
  persist();
  renderPractice();
  if (view === 'journey') renderJourney();
  focusAnswer({ select: round.completed });
  if (celebrate) playSound(saluteForId(round.saluteId, p.settings).text, { ...p.settings }, 'celebration');
  else if (round.byEar && round.completed && !round.solved) playSound(round.target, checkpointSettings(p.settings, activeListening(p).level), 'review');
  else if (!round.completed && !showLessonGuidance()) playRound();
  if (celebrate || earned.length) {
    const kind = celebrate ? round.focusComplete || round.byEarComplete ? 'focus' : 'level' : 'badge';
    const title = celebrate ? round.byEarComplete ? 'Copied by ear' : round.focusComplete ? 'Focus complete' : isEndless(p.settings) ? `Paragon ${p.endless.rank}` : `Level ${levelNumber(p.settings)} mastered` : earned[0].title;
    const detail = celebrate ? earned.length ? `+ ${earned.map(b => b.title).join(' · ')}` : `+${round.awarded} XP · ${round.focusComplete || round.byEarComplete ? 'Back to your course' : 'Next level coming up'}` : earned.length > 1 ? earned.slice(1).map(b => b.title).join(' · ') : earned[0].description;
    rewards.show({ kind, title, detail, icon: celebrate ? 'spark' : earned[0].icon, badges: earned });
  }
}

$('lab-lesson').innerHTML = LESSONS.map(lesson => `<option value="${lesson.id}">${lesson.name}</option>`).join('');
$('lab-level').innerHTML = Array.from({ length: 10 }, (_, i) => `<option value="${i + 1}">Level ${i + 1} · ${i + 1} character${i ? 's' : ''}</option>`).join('');
$('lab-course-level').innerHTML = Array.from({ length: COURSE_LEVELS }, (_, i) => `<option value="${i + 1}">${i + 1} · ${courseStage(i + 1).label} · ${courseStage(i + 1).letterCount} letters${listeningCheckpoint(i + 1) ? ' · By ear follows' : ''}</option>`).join('');

document.addEventListener('click', event => {
  const viewButton = event.target.closest('button[data-view]');
  if (viewButton) changeView(viewButton.dataset.view);
  const closeButton = event.target.closest('[data-close]');
  if (closeButton) {
    finishDialog($(closeButton.dataset.close));
  }
  const level = event.target.closest('[data-level]');
  if (level) {
    changeSettings({ [isGrowingCourse(profile().settings) ? 'courseLevel' : 'level']: Number(level.dataset.level) });
    focusAnswer();
    announce(`Level ${levelNumber(profile().settings)}. Your next signal is ready.`);
  }
  const character = event.target.closest('[data-character]');
  if (character) {
    markAssisted();
    focusAnswer();
    playSound(character.dataset.character, { ...profile().settings }, 'character', character.dataset.character);
  }
  const example = event.target.closest('[data-course-example]');
  if (example && $('guidance-dialog').open) playSound(example.dataset.courseExample, { ...profile().settings }, 'example', example.dataset.courseExample);
  const guidedCharacter = event.target.closest('[data-guidance-character]');
  if (guidedCharacter && $('guidance-dialog').open) {
    if (guidanceContext?.repetitions) $('guidance-answer').focus({ preventScroll: true });
    else {
      const character = guidedCharacter.dataset.guidanceCharacter;
      playSound(character, { ...profile().settings }, 'guidance', character);
    }
  }
  const envelope = event.target.closest('[data-envelope]');
  if (envelope) { const ms = { crisp: 2, balanced: 5, soft: 10 }[envelope.dataset.envelope]; changeSettings({ rise: ms, fall: ms, curve: 'smooth' }); }
});

document.addEventListener('input', event => {
  const control = event.target.closest('[data-setting]');
  if (!control) return;
  const key = control.dataset.setting;
  if (control.type === 'range' && soundFields.includes(key)) {
    const preview = (name, value, unit) => {
      document.querySelector(`[data-value="${name}"]`).textContent = value;
      control.setAttribute('aria-valuetext', `${value} ${unit}`);
    };
    preview(key,control.value,({wpm:'words per minute',farnsworth:'words per minute',tone:'hertz',volume:'percent'})[key] || 'milliseconds');
    return;
  }
  if (key === 'custom') return; // Apply a custom alphabet on change, after typing.
  const value = control.type === 'checkbox' ? control.checked : control.type === 'range' || ['level', 'courseLevel'].includes(key) ? Number(control.value) : control.value;
  if (key === 'showMorse') {
    const p = profile(), round = p.round;
    if (round && (round.byEar || courseByEar(p) || p.settings.visualSupport === 'auto' && round.visualPhase !== 'live')) {
      round.visualRevealed = value;
      round.visualHidden = !value;
      if (value && !round.completed) {
        round.visualUsed = true;
        if (round.byEar || courseByEar(p) || p.settings.copyMode === 'head') round.assisted = true;
      }
      persist(); renderMorseVisibility(); renderCopyPace(); focusAnswer();
      return;
    }
    profile().settings.showMorse = value;
    profile().settings.visualSupport = value ? profile().settings.visualSupport === 'auto' ? 'auto' : 'always' : 'off';
    if (profile().round) profile().round.earOnly = !value;
    if (value && profile().settings.copyMode === 'head') markAssisted();
    persist();
    renderMorseVisibility();
    focusAnswer();
    return;
  }
  changeSettings({ [key]: value });
});

document.addEventListener('change', event => {
  const control = event.target.closest('input[type="range"][data-setting]');
  if (control && soundFields.includes(control.dataset.setting)) changeSettings({[control.dataset.setting]: Number(control.value)});
});

$('lab-custom').addEventListener('change', event => {
  const characters = supportedCharacters(event.target.value);
  if (!characters) { event.target.value = profile().settings.custom; announce('Choose at least one supported character.'); return; }
  const rejected = [...new Set(normalizeText(event.target.value).replaceAll(' ', ''))].filter(c => !Object.hasOwn(MORSE, c));
  changeSettings({ custom: characters });
  event.target.value = characters;
  if (rejected.length) announce(`Kept supported characters. Unavailable: ${rejected.join(' ')}`);
});

$('answer').addEventListener('input', event => {
  pendingAnswerKey = null;
  const round = profile().round;
  if (!round) return;
  if (profile().settings.copyMode === 'head' && playing && playingKind === 'round' && !round.completed) {
    event.target.value = round.draft;
    return;
  }
  if (round.completed) {
    if (celebrating || playingKind === 'review') {
      event.target.value = '';
      focusAnswer();
      return;
    }
    if (normalizeText(event.target.value)) nextRound({ draft: event.target.value });
    return;
  }
  if (copySession?.round === round) {
    round.responseTimes = recordCopyInput(copySession.session, event.target.value, performance.now());
    if (round.firstGuess === null && round.plays === 1 && !round.assisted && copySession.session.mistakes.some(Boolean)) round.mistakes = copySession.session.mistakes;
    recordTypedMistakes(profile());
    round.headCopyMs = headCopyResponse(copySession.session);
  }
  round.draft = event.target.value;
  persist();
  renderCopyPace();
  // Phone keyboards may keep Latin letters in composition until Enter. A full
  // matching Morse answer is ready to check even before that composition ends.
  checkTypedAnswer();
});
$('answer').addEventListener('beforeinput', event => {
  if (profile().settings.copyMode === 'head' && playing && playingKind === 'round') { pendingAnswerKey = null; event.preventDefault(); }
});
$('answer').addEventListener('compositionstart', () => { composing = true; pendingAnswerKey = null; });
$('answer').addEventListener('compositionend', () => { composing = false; setTimeout(checkTypedAnswer, 0); });
$('answer-form').addEventListener('submit', checkAnswer);
$('play-signal').addEventListener('click', playOrPause);
$('copy-pace').addEventListener('click', () => {
  changeView('lab');
  $('lab-timing-mode').focus();
});
$('mastery-info').addEventListener('click', () => {
  if (profile().focus?.active) { showLessonGuidance({ reference: true }); return; }
  if (isEndless(profile().settings)) {
    $('radio-progress').textContent = `Paragon ${profile().endless.rank} · ${profile().endless.xp}/${rankGoal(profile().endless.rank)} XP · ${profile().endless.contacts} completed contacts`;
    openDialog('radio-dialog');
    $('radio-done').focus({ preventScroll: true });
    return;
  }
  openDialog('mastery-dialog');
  renderMasteryExplanation();
  $('mastery-done').focus({ preventScroll: true });
});
function returnToCourse({ fromDialog = null } = {}) {
  const p = profile();
  if (p.listening.active) {
    stopPlayback();
    leaveListening(p); p.round = null;
    ensureRound(); persist(); render();
    if (!showLessonGuidance()) { focusAnswer(); playRound(); }
    return;
  }
  if (!p.focus?.active) return;
  if (focusCardOpen()) fromDialog = $('guidance-dialog');
  if (fromDialog) finishLessonGuidance();
  stopPlayback();
  if (p.round && !p.round.completed) completeListening(p);
  endFocus(p); p.round = null;
  ensureRound(); persist(); render(); focusAnswer({ fromDialog });
  if (!showLessonGuidance()) playRound();
}
$('return-course').addEventListener('click', () => returnToCourse());
$('skip-button').addEventListener('click', () => {
  const round = profile().round;
  if (!round) return;
  stopPlayback();
  completeListening(profile());
  persist();
  render();
  focusAnswer({ select: true });
});
$('hint-button').addEventListener('click', () => {
  const round = profile().round;
  if (!round) return;
  stopPlayback();
  round.hintOpen = !round.hintOpen;
  round.assisted = true;
  persist();
  renderPractice();
  focusAnswer();
});
$('chart-button').addEventListener('click', openChart);
$('learn-letters').addEventListener('click', () => showLessonGuidance({ reference: true }));
$('slower-button').addEventListener('click', () => playRound({ slower: true }));
$('reveal-button').addEventListener('click', () => {
  stopPlayback();
  const p = profile();
  if (!p.round) return;
  p.round.assisted = true;
  completeListening(p);
  persist();
  render();
  focusAnswer({ select: true });
});
$('lab-test').addEventListener('click', preview);
$('choose-lesson').addEventListener('click', () => changeView('lab', { lesson: true }));
$('fix-lesson').addEventListener('click', () => changeView('lab', { lesson: true }));
$('reset-audio').addEventListener('click', () => { changeSettings({ rise: DEFAULT_SETTINGS.rise, fall: DEFAULT_SETTINGS.fall, curve: DEFAULT_SETTINGS.curve }); announce('Tone envelope reset.'); });
$('theme-toggle').addEventListener('click', () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; persist(); renderHeader(); });
$('open-progress').addEventListener('click', () => { openDialog('progress-dialog'); void refreshService(); });
$('open-help').addEventListener('click', () => openDialog('help-dialog'));
$('practice-weak').addEventListener('click', () => {
  const weak = weakCharacters();
  if (!weak.length) return;
  if (beginFocus(profile(), weak.map(([c]) => c).join(''))) {
    stopPlayback(); profile().round = null; ensureRound(); persist(); changeView('practice');
    return;
  }
  changeSettings({ lesson: 'custom', custom: weak.map(([c]) => c).join(''), content: 'groups', level: 1 });
  changeView('practice');
  announce('Character review selected.');
});

$('reset-progress').addEventListener('click', () => {
  cancelImport(); cancelProgressReset();
  $('progress-message').textContent = '';
  pendingResetId = profile().id;
  pendingResetScope = 'listen';
  $('reset-progress-confirmation').hidden = false;
  $('cancel-reset-progress').focus();
});
$('cancel-reset-progress').addEventListener('click', () => {
  cancelProgressReset();
  $('reset-progress').focus({ preventScroll: true });
});
$('confirm-reset-progress').addEventListener('click', () => {
  applyProgressReset('listen');
});
$('reset-send-progress').addEventListener('click', () => {
  cancelImport(); cancelProgressReset();
  $('progress-message').textContent = '';
  pendingResetId = profile().id; pendingResetScope = 'send';
  $('reset-send-confirmation').hidden = false;
  $('cancel-reset-send').focus({ preventScroll: true });
});
$('cancel-reset-send').addEventListener('click', () => { cancelProgressReset(); $('reset-send-progress').focus({ preventScroll: true }); });
$('confirm-reset-send').addEventListener('click', () => applyProgressReset('send'));
function applyProgressReset(scope) {
  if (pendingResetId !== profile().id || pendingResetScope !== scope) { cancelProgressReset(); return; }
  const learner = scope === 'send' ? resetSendingProgress(profile()) : resetListeningProgress(profile());
  if (scope === 'listen') ensureRound('', learner);
  const resetState = { ...state, profiles: state.profiles.map(p => p.id === learner.id ? learner : p) };
  // Keep the current learner cookie: the learner's identity has not changed.
  try { storage.atomic(()=>{ if (!saveState(storage,resetState)) throw Error(); deviceSync?.replace(scope === 'send' ? 'reset-send' : 'reset-listen'); }); } catch {
    $('progress-message').textContent = 'Could not save the reset. Your progress was kept. Try again when local storage is available.';
    return;
  }
  stopPlayback({ save: false });
  state = resetState;
  composing = false;
  cancelProgressReset();
  $('progress-message').textContent = '';
  finishDialog($('progress-dialog'), { returnToPractice: false });
  changeView(scope === 'send' ? 'send' : 'practice');
}
$('export-progress').addEventListener('click', () => exportLearner(profile()));
function exportLearner(learner) {
  persist();
  const blob = new Blob([JSON.stringify({ ...state, activeId: learner.id, profiles: [learner], exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `morse-progress-${localDay()}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('progress-message').textContent = 'Progress exported. Keep the file to restore or move your progress.';
}
$('import-progress').addEventListener('click', () => $('import-file').click());
$('guidance-continue').addEventListener('click', continueLessonGuidance);
$('guidance-close').addEventListener('click', () => finishDialog($('guidance-dialog')));
$('guidance-skip').addEventListener('click', () => finishLessonGuidance({ play: true }));
$('guidance-dialog').addEventListener('keydown', event => {
  if (focusCardOpen()) return;
  if (guidanceContext?.repetitions) {
    if (event.key === 'Enter' || event.repeat) { event.preventDefault(); event.stopPropagation(); }
    // A phone may keep the same composition open across multiple key presses.
    // A fresh key can start the next listen; a delayed commit alone cannot.
    else if (!playing) lessonCompositionAccepted = false;
    return;
  }
  if (event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) continueLessonGuidance();
});
$('guidance-answer').addEventListener('input', typeLessonLetter);
$('guidance-answer').addEventListener('paste', () => { if (!playing && !lessonComposing) lessonCompositionAccepted = false; });
$('guidance-answer').addEventListener('compositionstart', () => { lessonComposing = true; lessonCompositionAccepted = false; });
$('guidance-answer').addEventListener('compositionend', event => {
  lessonComposing = false;
  if (lessonCompositionAccepted) $('guidance-answer').value = '';
  else typeLessonLetter(event);
});
function previewImportedLearner() {
  if (!pendingImport) return;
  const incoming = pendingImport.profiles.find(p => p.id === $('import-learner').value);
  if (!incoming) return;
  pendingImport.activeId = incoming.id;
  $('import-summary').textContent = `Listening level ${levelNumber(incoming.settings)} · Sending level ${incoming.sending.level} · ${incoming.stats.xp.toLocaleString()} XP`;
}
$('import-learner').addEventListener('change', previewImportedLearner);
$('import-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  cancelProgressReset();
  cancelImport();
  const generation = importGeneration;
  const controller = new AbortController();
  importController = controller;
  $('progress-message').textContent = '';
  try {
    const imported = await readProgressFile(file, { signal: controller.signal });
    if (generation !== importGeneration || controller.signal.aborted || !$('progress-dialog').open) return;
    pendingImport = imported;
    $('import-selection').hidden = imported.profiles.length < 2;
    $('import-learner').replaceChildren(...imported.profiles.map(p => new Option(`${p.callsign || p.name} · ${p.stats.xp} XP`, p.id)));
    $('import-learner').value = imported.activeId;
    previewImportedLearner();
    $('import-confirmation').hidden = false;
    $('progress-message').textContent = '';
  } catch (error) {
    if (generation === importGeneration && error.name !== 'AbortError' && $('progress-dialog').open) $('progress-message').textContent = error.message;
  } finally { if (importController === controller) importController = null; }
});
$('cancel-import').addEventListener('click', cancelImport);
$('confirm-import').addEventListener('click', () => {
  if (!pendingImport) return;
  const incoming = pendingImport.profiles.find(p => p.id === pendingImport.activeId);
  const restored = { ...incoming, id: profile().id, leaderboard: profile().leaderboard === true && incoming.callsign === profile().callsign };
  ensureRound('', restored);
  // Older saves may contain extra profiles. Keep those records untouched; only
  // the progress selected in the file replaces this browser's current progress.
  const imported = { ...state, theme: pendingImport.theme, profiles: state.profiles.map(p => p.id === restored.id ? restored : p) };
  try { storage.setItem(`${STORAGE_KEY}.backup`, JSON.stringify(state)); }
  catch { $('progress-message').textContent = 'Could not back up the current save. Export it before importing.'; return; }
  try { storage.atomic(()=>{ if (restored.callsign!==profile().callsign) storage.consent(profile(),restored.callsign,false); storage.setItem(STORAGE_KEY, JSON.stringify(imported)); storage.row().stream=crypto.randomUUID(); storage.row().foundation=syncProfile(restored); deviceSync?.replace('import'); }); }
  catch { $('progress-message').textContent = 'Could not save the imported progress. Your current progress was kept.'; return; }
  stopPlayback({ save: false });
  state = imported;
  cancelImport();
  persist();
  render();
  $('import-confirmation').hidden = true;
  finishDialog($('progress-dialog'));
  announce('Progress restored.');
});

document.addEventListener('keydown', event => {
  if (event.key === 'Tab') cancelAnswerFocus();
  const inDialog = blockingPracticeDialog();
  if (inDialog || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  const typingKey = event.key.length === 1 || ['Backspace', 'Delete'].includes(event.key);
  pendingAnswerKey = event.target === $('answer') && answerFocus && typingKey && !event.isComposing && !composing ? {
    code: event.code, key: event.key, learnerId: profile().id, round: profile().round,
    value: $('answer').value, start: $('answer').selectionStart, end: $('answer').selectionEnd,
  } : null;
  // A key can arrive before the browser's queued close/focus events. Preserve
  // that first keystroke instead of dropping it on the document or old opener.
  if (view === 'practice' && profile().round && event.target !== $('answer') && canReturnAnswerFocus(event.target) && !event.isComposing && !composing) {
    if (typingKey) {
      event.preventDefault();
      focusAnswer();
      writeAnswerKey(event.key);
      return;
    }
    if (event.key === 'Enter') { event.preventDefault(); focusAnswer(); checkAnswer(); return; }
  }
  if (event.key === 'Enter' && event.target === $('answer') && view === 'practice') {
    event.preventDefault(); composing = false; checkAnswer(); return;
  }
  if (event.isComposing || composing) return;
  if (event.key === 'Escape' && view === 'practice') {
    event.preventDefault();
    if (profile().focus?.active) returnToCourse();
    else { stopPlayback(); renderPractice(); focusAnswer({ select: profile().round?.completed }); }
    return;
  }
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName);
  if (event.code === 'Space' && !typing && event.target.tagName !== 'BUTTON' && view === 'practice') {
    event.preventDefault(); playOrPause();
  }
  if (event.key === 'Enter' && view === 'practice' && profile().round?.completed && event.target.tagName !== 'BUTTON') {
    event.preventDefault(); nextRound();
  }
});
document.addEventListener('keyup', event => {
  const key = pendingAnswerKey;
  if (!key || event.code !== key.code) return;
  pendingAnswerKey = null;
  const input = $('answer');
  if (!answerFocus || event.isComposing || composing || view !== 'practice' || document.hidden || blockingPracticeDialog() ||
      profile().id !== key.learnerId || profile().round !== key.round || input.value !== key.value || !canReturnAnswerFocus()) return;
  // Chromium can deliver keydown/keypress to the focused field after a modal
  // closes but omit the native editing/input event. Recover only that missing
  // edit; normal typing and IME input already cleared pendingAnswerKey.
  input.blur();
  focusAnswer();
  writeAnswerKey(key.key, key.start, key.end);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (playing || continuous || nextSignalTimer !== null) stopPlayback({ interrupted: true });
    audio.release();
  }
  if (!document.hidden) { renderPractice(); showLessonGuidance(); }
});
document.addEventListener('focusin', event => {
  queueKeyboardLayout();
  if (event.target === $('answer') && !answerFocus) focusAnswer();
});
document.addEventListener('focusout', () => {
  queueKeyboardLayout();
  queueAnswerFocus();
});
document.addEventListener('pointerdown', event => {
  if (event.target.closest('dialog,button,a,input,textarea,select,summary,[tabindex]:not([tabindex="-1"]),[contenteditable]:not([contenteditable="false"])') && event.target !== $('answer')) cancelAnswerFocus();
  else if (view === 'practice' && !blockingPracticeDialog()) {
    answerFocus = { learnerId: profile().id, fromDialog: null, opener: null };
    queueAnswerFocus();
  }
});
window.addEventListener('focus', settleAnswerFocus);
window.addEventListener('resize', queueKeyboardLayout);
window.visualViewport?.addEventListener('resize', queueKeyboardLayout);
window.visualViewport?.addEventListener('scroll', queueKeyboardLayout);
new ResizeObserver(fitMorseTrace).observe($('live-morse'));
if (window.morseMac) window.addEventListener('morse-save-before-update', event => { event.detail.saved = persist(); });
window.addEventListener('pagehide', () => { stopPlayback(); audio.release(); persist(); });
window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY || !event.newValue) return;
  try {
    if (window.morseMac) return;
    const updated = importState(storage.external(event.newValue), { newSessionOwner: false });
    const current = profile(), incoming = updated.profiles.find(p => p.id === updated.activeId);
    if (updated.activeId !== current.id) { location.reload(); return; }
    if (incoming?.id === current.id) incoming.sessionId = incoming.stats.sessions.some(row => row.id === current.sessionId) ? current.sessionId : '';
    cancelImport();
    cancelProgressReset();
    stopPlayback({ save: false });
    guidanceContext = null;
    restorePracticeWorkspace();
    cancelAnswerFocus();
    closeNativeDialog($('guidance-dialog'));
    state = updated;
    resumeStations();
    render();
    showLessonGuidance();
    announce('Progress updated from another tab.');
  } catch { /* Keep the current valid state if another tab wrote invalid data. */ }
});
$$('dialog').forEach(dialog => {
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (dialog === $('guidance-dialog') && profile().focus?.active) returnToCourse({ fromDialog: dialog });
    else finishDialog(dialog);
  });
  dialog.addEventListener('close', () => {
    const handled = handledDialogCloses.get(dialog) || 0;
    if (handled) {
      handledDialogCloses.set(dialog, handled - 1);
    } else if (!dialog.open) {
      finishDialog(dialog);
    }
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) {
      finishDialog(dialog);
    }
  });
});
window.addEventListener('hashchange', () => {
  const invitation = /^#pair=([A-Za-z0-9_-]{43})$/.exec(location.hash)?.[1];
  if (invitation) {
    pairingInvitation = invitation;
    history.replaceState(null, '', '#practice');
    $$('dialog').filter(d => d.open).forEach(d => finishDialog(d, { returnToPractice: false }));
    openDialog('progress-dialog');
    renderDeviceSync(deviceSync.status);
    return;
  }
  const next = location.hash.slice(1);
  if (['practice', 'send', 'journey', 'lab'].includes(next)) changeView(next);
});

sender = new SendingUI({ getProfile: profile, persist, soundChoice: renderSoundChoice, inputSettingsOpen: () => view === 'lab', active: () => view === 'send', onEarn: (xp,id) => { storage.result(profile(),'send',xp,id); profile().stats.xp = Math.min(1e9, profile().stats.xp + xp); } });
ensureRound();
const initialView = location.hash.slice(1);
if (['practice', 'send', 'journey', 'lab'].includes(initialView)) view = initialView;
render();
function stationFor(id) {
  if (learnerStations.has(id)) return learnerStations.get(id);
  const local = () => state.profiles.find(p => p.id === id);
  const station = new Station({
    mac, canPublish: () => service.scores, canSync: () => service.privateSync, storage: storage.forLearner(id), getProfile: local,
    ready: () => !!local() && (id !== state.activeId || !playing && !continuous && !composing && !sender?.busy && !sender?.nextTimer && !$$('dialog').some(d => d.open && !['progress-dialog', 'callsign-intro-dialog'].includes(d.id) && !(d === $('guidance-dialog') && focusCardOpen()))),
    applyProfile(shared, options) {
      if (id === state.activeId) return acceptSyncedProfile(shared, options);
      const next = localProfileWithSync(local(), shared, options?.replace);
      state.profiles = state.profiles.map(p => p.id === id ? next : p);
      if (!saveState(storage,state)) throw new Error('Could not save the synced learner.');
    },
    backup: () => storage.setItem(STORAGE_KEY+'.pairing-backup.'+id, JSON.stringify(state)),
    onStatus: status => { if (state.activeId === id) renderDeviceSync(status); },
    onScoresPublished: () => {
      if (state.activeId !== id) return;
      leaderboardUpdated = 0;
      if (view === 'journey') void refreshLeaderboard(true);
    },
    onErased: () => { if (state.activeId === id) clearMorseData(); },
  });
  learnerStations.set(id,station);
  return station;
}
function resumeStations() {
  for (const p of state.profiles) {
    const row = storage.row(p.id);
    if (p.id === state.activeId || row.private || row.scores.length || row.needsConsent || row.history?.decision === 'queued') stationFor(p.id).schedule(0);
  }
}
deviceSync = stationFor(state.activeId);
$('callsign-intro-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (callsignIntroBusy) return;
  const input = $('intro-callsign'), callsign = sanitizeCallsign(input.value);
  const message = $('intro-callsign-message');
  if (!callsign) {
    message.textContent = input.value.trim() ? 'Use 2–16 letters, numbers or / for your callsign.' : 'Enter your callsign, or skip for now.';
    input.setAttribute('aria-invalid', 'true');
    input.focus({ preventScroll: true });
    return;
  }
  callsignIntroBusy = true;
  input.removeAttribute('aria-invalid');
  $('callsign-intro-form').setAttribute('aria-busy', 'true');
  $('join-leaderboard').disabled = true; $('skip-callsign').disabled = true;
  message.textContent = 'Adding your station…';
  try {
    saveSharing(callsign,$('intro-share').checked);
    identityDirty = false; leaderboardUpdated = 0;
    callsignIntroBusy = false;
    finishDialog($('callsign-intro-dialog'));
  } catch (error) {
    message.textContent = ['TypeError', 'TimeoutError'].includes(error.name) ? 'Could not reach the leaderboard. Try again, or skip for now and learn offline.' : error.message || 'Could not join yet. Try again, or skip for now and learn offline.';
    input.focus({ preventScroll: true });
  } finally {
    callsignIntroBusy = false;
    $('callsign-intro-form').removeAttribute('aria-busy');
    $('join-leaderboard').disabled = false; $('skip-callsign').disabled = false;
  }
});
$('learner-callsign').addEventListener('input', () => { identityDirty = true; });
$('list-on-leaderboard').addEventListener('change', () => {
  const p = profile(), enabled = $('list-on-leaderboard').checked;
  const sameCallsign = !!p.callsign && sanitizeCallsign($('learner-callsign').value) === p.callsign;
  identityDirty = !sameCallsign;
  if (enabled && !sameCallsign) {
    $('callsign-message').textContent = 'Save your callsign to start sharing new scores.';
    return;
  }
  try {
    saveSharing(p.callsign, enabled);
    $('callsign-message').textContent = enabled ? 'Sharing on for new scores.' : 'Sharing off. Pending scores cleared.';
  } catch {
    $('list-on-leaderboard').checked = p.leaderboard;
    $('callsign-message').textContent = 'Could not save the sharing change. Try again.';
  }
});
$('save-callsign').addEventListener('click', event => pairingAction(event.currentTarget, async () => {
  const raw = $('learner-callsign').value.trim(), callsign = sanitizeCallsign(raw), listed = $('list-on-leaderboard').checked;
  $('callsign-message').textContent = '';
  if (raw && !callsign) { $('callsign-message').textContent = 'Use 2–16 letters, numbers or / for your callsign.'; return; }
  if (listed && !callsign) { $('callsign-message').textContent = 'Add your callsign to join the leaderboard.'; return; }
  saveSharing(callsign,listed);
  identityDirty = false; renderSavedProgress(); leaderboardUpdated = 0;
  $('callsign-message').textContent = listed ? 'Callsign saved. Eligible scores will be submitted when connected.' : 'Callsign saved. Score sharing is off.';
}));
$('refresh-leaderboard').addEventListener('click', () => refreshLeaderboard(true));
$('delete-all-data').addEventListener('click', () => {
  cancelImport(); cancelProgressReset();
  $('delete-data-confirmation').hidden = false;
  $('cancel-delete-data').focus({ preventScroll: true });
});
$('cancel-delete-data').addEventListener('click', () => { $('delete-data-confirmation').hidden = true; $('delete-all-data').focus({ preventScroll: true }); });
$('confirm-delete-data').addEventListener('click', event => pairingAction(event.currentTarget, async () => {
  try { await deviceSync.erase(); }
  catch (error) { throw new Error(navigator.onLine === false ? 'Reconnect to delete the shared save from all devices. Your data has been kept.' : error.message); }
}));
$('pair-devices').addEventListener('click', event => pairingAction(event.currentTarget, async () => {
  const invite = deviceSync.status.connected;
  if (!mac && !invite && await adoptWebsiteProfile()) return;
  const result = await deviceSync.start(deviceLabel(), { invite });
  if (!invite) {
    renderDeviceSync(deviceSync.status);
    $('station-recovery').focus();
    return;
  }
  pairingOffer = result.invitation;
  const link = `${pairingOrigin}/#pair=${pairingOffer}`;
  $('pair-link').value = link; showPairQr(link);
  $('pair-offer').hidden = false;
  renderDeviceSync(deviceSync.status);
}));
$('copy-pair-link').addEventListener('click', event => pairingAction(event.currentTarget, async () => {
  try { await navigator.clipboard.writeText($('pair-link').value); $('pair-message').textContent = 'Link copied. Open it on your other device.'; }
  catch { $('pair-link').focus(); $('pair-link').select(); $('pair-message').textContent = 'Copy the selected link and open it on your other device.'; }
}));
$('join-pairing').addEventListener('click', event => pairingAction(event.currentTarget, async () => {
  await deviceSync.join(pairingInvitation, deviceLabel());
  pairingInvitation = null;
  renderDeviceSync(deviceSync.status);
}));
$('decline-pairing').addEventListener('click', () => { pairingInvitation = null; renderDeviceSync(deviceSync.status); });
for (const id of ['cancel-pairing', 'cancel-waiting', 'reject-pairing']) $(id).addEventListener('click', event => pairingAction(event.currentTarget, async () => {
  await deviceSync.cancel(); pairingOffer = null; $('pair-offer').hidden = true; renderDeviceSync(deviceSync.status);
}));
$('approve-pairing').addEventListener('click', event => pairingAction(event.currentTarget, async () => {
  const claim = deviceSync.status.invite?.claim;
  if (!claim) return;
  const result = await deviceSync.approve(claim);
  $('pair-message').textContent = 'Paired. Both devices will receive the merged progress.';
}));
$('sync-devices').addEventListener('click', event => {
  const button = event.target.closest('[data-disconnect]');
  if (button) pairingAction(button, () => deviceSync.disconnect(button.dataset.disconnect));
});
async function adoptWebsiteProfile() {
  // The old HttpOnly browser credential can prove ownership when sync is explicitly enabled.
  let result;
  try { result = await deviceSync.request('adopt'); }
  catch (error) { if (error.status === 403) return false; throw error; }
  deviceSync.backup();
  let previous;
  try { previous=JSON.parse(storage.storage.getItem('morse.devices.v1')); } catch { /* Missing legacy baseline. */ }
  const current=syncProfile(profile());
  let baseline=previous?.epoch===result.epoch ? previous.base : null;
  if (baseline && previous.pending && previous.pending.seq<=result.seq) baseline=previous.pending.profile;
  const merged=baseline ? mergeProgress(baseline,current,result.profile)
    : pairedProgress(result.profile,current,result.profile,storage.row().foundation || current).profile;
  storage.atomic(()=>{
    if (!previous?.replacement && !previous?.pending) acceptSyncedProfile(merged);
    const meta = {version:1,base:result.profile,epoch:result.epoch,seq:result.seq,revision:result.revision};
    if (previous?.replacement || previous?.pending) {
      // Continue the device's original sequence. Lost acknowledgements are idempotent.
      // The existing journal also retains the baseline used by offline imports and resets.
      deviceSync.save(previous);
    } else deviceSync.save(meta);
  });
  deviceSync.schedule(0);
  return true;
}
let pendingRecovery = null;
$('recover-replace').onclick=e=>pairingAction(e.currentTarget,async()=>{
  if (!pendingRecovery) return;
  await deviceSync.recover(pendingRecovery,$('recovery-old-device').value);
  pendingRecovery=null; $('recovery-replacement').hidden=true;
});
$('station-redeem').onclick=e=>pairingAction(e.currentTarget,async()=>{
  const value=$('station-code').value.trim();
  const invite = value.startsWith(pairingOrigin+'/#pair=') ? /^([A-Za-z0-9_-]{43})$/.exec(value.slice((pairingOrigin+'/#pair=').length)) : null;
  $('station-code').value='';
  if (invite) { pairingInvitation=invite[1]; renderDeviceSync(deviceSync.status); }
  else if (/^[A-Za-z0-9_-]{32}$/.test(value)) {
    pendingRecovery=null; $('recovery-replacement').hidden=true;
    const devices=await deviceSync.recover(value);
    if (devices) {
      pendingRecovery=value;
      $('recovery-old-device').replaceChildren(...devices.map(d=>new Option(d.label,d.id)));
      $('recovery-replacement').hidden=false;
    }
  }
  else throw new Error('Enter a pairing link or a recovery code from a linked device.');
});
$('station-recovery').onclick=async e=>{
  if (recoveryBusy || !deviceSync.status.connected || deviceSync.status.waiting || !service.privateSync) return;
  const generation = ++recoveryGeneration, id = profile().id;
  recoveryBusy = true; e.currentTarget.disabled = true;
  $('pair-message').textContent = ''; $('recovery-issued').hidden = true; $('recovery-output').textContent = '';
  try {
    const { code } = await deviceSync.request('recovery-code');
    if (generation === recoveryGeneration && profile().id === id && deviceSync.status.connected && !deviceSync.status.waiting && $('progress-dialog').open) {
      $('recovery-output').textContent = code; $('recovery-issued').hidden = false;
    }
  } catch (error) { if (generation === recoveryGeneration) $('pair-message').textContent = error.message; }
  finally { recoveryBusy = false; renderDeviceSync(deviceSync.status); }
};
$('progress-dialog').addEventListener('close',()=>{
  recoveryGeneration++; pendingRecovery=null; $('recovery-replacement').hidden=true;
  $('recovery-issued').hidden=true; $('recovery-output').textContent=''; $('station-code').value=''; $('publish-history').hidden=true;
});
for (const [button,publish] of [['share-previous-results',true],['keep-previous-results',false]]) {
  $(button).onclick = () => { storage.decidePreviousScores(profile(),publish); deviceSync.changed(); renderSavedProgress(); };
}
$('preview-history').onclick=e=>pairingAction(e.currentTarget,async()=>{
  const p=profile(), row=storage.row(p.id);
  if (!p.leaderboard || !p.callsign) throw new Error('Enable score sharing for your callsign before previewing a submission.');
  await deviceSync.flushScores();
  const info=await deviceSync.exchange('scores/history-preview',{generation:row.generation});
  if (info.imported) throw new Error('Historical scores have already been imported for this station.');
  $('legacy-score-summary').textContent=`Publish up to ${Math.max(0,row.history.xp-info.previous)} historical XP for ${p.callsign}. Existing historical balance: ${info.previous} XP. Old exports may overlap. This import can be used once.`;
  $('publish-history').dataset.consent=String(row.generation); $('publish-history').hidden=false;
});
$('publish-history').onclick=()=>{
  const row=storage.row();
  if (!profile().leaderboard || row.history?.decision!=='pending' || String(row.generation)!==$('publish-history').dataset.consent) return;
  storage.atomic(()=>{Object.assign(row.history,{decision:'queued',id:crypto.randomUUID()});});
  deviceSync.changed(); renderSavedProgress();
};
$('keep-history').onclick=()=>{storage.atomic(()=>{storage.row().history.decision='private';}); renderSavedProgress();};
window.addEventListener('online', () => { void refreshService(); resumeStations(); });
window.addEventListener('focus', refreshService);
window.addEventListener('focus', () => { if (deviceSync.meta()) deviceSync.schedule(0); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && deviceSync.meta()) deviceSync.schedule(0); });
if (pairingInvitation || initialView === 'progress') { openDialog('progress-dialog'); renderDeviceSync(deviceSync.status); }
else if (!showCallsignIntro() && !showLessonGuidance()) focusAnswer({ select: profile().round?.completed });
persist();
void refreshService();
resumeStations();
if (!window.morseMac && navigator.serviceWorker && ['/', '/index.html'].includes(location.pathname)) {
  navigator.serviceWorker.register('/practice-worker.mjs',{updateViaCache:'none'}).catch(()=>{});
}
if (view === 'journey') refreshLeaderboard();
if (loaded.warning) { $('storage-warning').textContent = loaded.warning; $('storage-warning').hidden = false; }
