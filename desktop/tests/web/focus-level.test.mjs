import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, newProfile, sanitizeSettings, startRound, finishRound, importState, resetLearnerProgress, nextPracticeStep, recordFirstReview, recordTypedMistakes } from '../../website/public/js/progress.mjs';
import { beginFocus, endFocus, emptyFocus, sanitizeFocus, trickySounds, focusPhase, focusPrompt, focusProgress, FOCUS_COOLDOWN } from '../../website/public/js/focus-level.mjs';
import { createCopySession, recordCopyInput, copyResponses, sanitizeMistakes } from '../../website/public/js/recognition.mjs';
import { observeReview } from '../../website/public/js/review.mjs';
import { practiceKey, alphabetFor } from '../../website/public/js/lessons.mjs';
import { timeline } from '../../website/public/js/morse.mjs';
import { syncProfile, mergeProgress } from '../../website/public/js/sync-data.mjs';

function learner(level=99) {
  const p=newProfile();p.settings=sanitizeSettings({...p.settings,courseLevel:level});return p;
}
function observe(p,target,guess=target,ms=200) {
  observeReview(p.review,{target,guess,responses:Array(guess.length).fill(ms)},10000);
}
function answer(p,target,{focus=true,ms=5000,guess=target,...extra}={}) {
  startRound(p,target,{focus});Object.assign(p.round,{heard:true,plays:1,attempts:1,firstGuess:guess,responseTimes:Array(target.length).fill(ms),...extra});
  return finishRound(p,{solved:guess===target,now:new Date(2026,10,22,12)});
}

function automaticFocus(p,target,guess=target,mistakes=[]) {
  startRound(p,target);
  Object.assign(p.round,{heard:true,plays:1,attempts:guess===null?0:1,firstGuess:guess,firstResponseTimes:[],mistakes});
  return beginFocus(p);
}

test('automatic focus cannot use an older weak sound to bypass the current sound’s three-error threshold',()=>{
  const p=learner();
  for(let i=0;i<6;i++)observe(p,'Z','S');
  for(let i=0;i<2;i++)observe(p,'C','K');
  assert.equal(automaticFocus(p,'CUL','KUL'),false,'an unrelated Z history cannot trigger a focus card after only two C errors');
  observe(p,'C','K');
  assert.equal(automaticFocus(p,'CUL','KUL'),true);
  assert.equal(p.focus.active.sounds,'C','the newly missed sound wins over the older higher-scoring sound');
});

test('automatic focus uses only missed expected sounds and never adds a healthy confusion partner or alphabet filler',()=>{
  const p=learner();
  for(let i=0;i<6;i++)observe(p,'Z','S');
  for(let i=0;i<3;i++)observe(p,'C','K');
  assert.equal(automaticFocus(p,'CUL','KUL'),true);
  assert.equal(p.focus.active.sounds,'C');
  for(let i=0;i<6&&focusPhase(p.focus.active);i++) {
    const target=focusPrompt(p.focus.active,p.round?.target,()=>.5);
    assert.ok([...target].every(c=>c==='C'));
    answer(p,target);
  }
  assert.equal(focusPhase(p.focus.active),0,'one-sound focus still completes singles, pairs and triples');
});

test('automatic focus distinguishes erased mistakes and omissions from unsubmitted text, extra input, spaces and joined signals',()=>{
  for(const {target,guess,mistakes=[],expected,level=99} of [
    {target:'CUL',guess:'CUL',mistakes:[{expected:'C',actual:'K'}],expected:'C'},
    {target:'CUL',guess:null,mistakes:[{expected:'C',actual:'K'}],expected:'C'},
    {target:'CUL',guess:null,expected:''},
    {target:'CUL',guess:'KUR',expected:'CL'},
    {target:'CUL',guess:'CL',expected:'U'},
    {target:'CUL',guess:'CULX',expected:''},
    {target:'CQ TU',guess:'CQTU',expected:''},
    {target:'AS',guess:'AT',expected:'',level:181},
  ]) {
    const p=learner(level);
    for(const c of new Set(target.replaceAll(' ','')))for(let i=0;i<3;i++)observe(p,c,c==='K'?'R':'K');
    const started=automaticFocus(p,target,guess,mistakes);
    assert.equal(started,!!expected,JSON.stringify({target,guess,mistakes}));
    if(started)assert.equal(p.focus.active.sounds,expected);
  }
});

test('three recent first-listen letter mistakes insert only currently missed taught sounds',()=>{
  const p=learner();observe(p,'K','R');assert.equal(automaticFocus(p,'K','R'),false);
  observe(p,'K','R');assert.equal(automaticFocus(p,'K','R'),false,'two errors do not open the focus card');
  observe(p,'K','R');assert.equal(automaticFocus(p,'K','R'),true);
  assert.equal(p.focus.active.sounds,'K');assert.equal(p.settings.courseLevel,99);
  assert.deepEqual(focusProgress(p.focus.active),{goal:12,done:0,phase:1});
  const beginner=learner(1);for(let i=0;i<3;i++)observe(beginner,'K','R');assert.equal(automaticFocus(beginner,'K','R'),false);
});

test('slow accurate recognition, repeated letters and historical mistakes alone do not trigger a focus level',()=>{
  const p=learner();for(let i=0;i<8;i++)observe(p,'K','K',9000);assert.equal(automaticFocus(p,'K'),false);
  observe(p,'KKKK','RRRR');assert.deepEqual(p.review.sounds.K.recent.slice(-1),[false]);assert.equal(automaticFocus(p,'KKKK','RRRR'),false);
  observe(p,'K','R');observe(p,'K','R');observe(p,'K');assert.equal(automaticFocus(p,'K','R'),false,'most recent sound is already correct');
  delete p.review.sounds.K.recent;assert.equal(automaticFocus(p,'K','R'),false,'old lifetime totals do not invent a recent error window');
});

test('focus singles, pairs and triples have a short accuracy goal and never award normal course mastery',()=>{
  const p=learner();p.stats.mastery[practiceKey(p.settings)]={history:[false],recognition:[null],mastered:false};
  const original=structuredClone(p.stats.mastery),pacing=structuredClone(p.pacing);
  assert.equal(beginFocus(p,'KR'),true);
  const lengths=[];let result;
  for(let i=0;i<10&&focusPhase(p.focus.active);i++) {
    const target=focusPrompt(p.focus.active,p.round?.target,()=>.8);lengths.push(target.length);
    result=answer(p,target);assert.equal(result.quick,false);assert.equal(result.promoted,false);assert.equal(nextPracticeStep(p),null);
  }
  assert.deepEqual(lengths,[1,1,1,1,2,2,3,3]);assert.equal(result.focusComplete,true);
  assert.deepEqual(p.stats.mastery,original);assert.deepEqual(p.pacing,pacing);assert.equal(p.stats.xp,160);
  assert.equal(p.stats.solved,8);assert.equal(p.stats.days['2026-11-22'],8);
  assert.deepEqual(focusProgress(p.focus.active),{goal:14,done:14,phase:0});
  assert.equal(finishRound(p,{solved:true}),null,'completed sound cannot award another win');
  endFocus(p);assert.equal(p.settings.courseLevel,99);assert.equal(p.focus.active,null);
});

test('replays, hints, skips and corrected input cannot complete focus steps; six course answers separate detours',()=>{
  const p=learner();beginFocus(p,'KR');
  answer(p,'K',{plays:2});answer(p,'R',{assisted:true});answer(p,'K',{guess:'R'});
  assert.equal(focusProgress(p.focus.active).done,0);
  endFocus(p);observe(p,'K','R');observe(p,'K','R');
  for(let i=0;i<FOCUS_COOLDOWN;i++) {
    assert.equal(beginFocus(p),false);answer(p,'CUL',{focus:false});
  }
  assert.equal(beginFocus(p),false,'old mistakes alone cannot start a detour after correct course answers');
  observe(p,'K','R');assert.equal(automaticFocus(p,'K','R'),true);
  assert.equal(beginFocus(p),false,'a focus level never nests another focus level');
});

test('focus stays within taught lengths and signals, clears on navigation/reset and survives bounded export/import',()=>{
  for(const level of [1,2,3,99,101,105,173,200]) {
    const state=newState(),p=state.profiles[0];p.settings=sanitizeSettings({...p.settings,courseLevel:level});
    assert.equal(beginFocus(p,alphabetFor(p.settings).slice(0,3)),true);
    const text=focusPrompt(p.focus.active);startRound(p,text,{focus:true});p.round.draft=text;
    const restored=importState(JSON.stringify(state)).profiles[0];assert.deepEqual(restored.focus,p.focus);assert.equal(restored.round.focus,true);
    assert.ok(restored.focus.active.maxLength<=3);assert.equal(sanitizeFocus(p.focus,sanitizeSettings({...p.settings,adaptive:false})).active,null);
    assert.equal(sanitizeFocus(p.focus,sanitizeSettings({...p.settings,courseLevel:level===200?199:level+1})).active,null);
    assert.deepEqual(resetLearnerProgress(p).focus,emptyFocus());
  }
  const p=learner(1);const key=practiceKey(p.settings);
  const safe=sanitizeFocus({key,active:{sounds:'<K>ETAN123🙂',singles:{E:1e99,T:-8},pairs:1e99,triples:2},cooldown:1e9},p.settings);
  assert.equal(safe.active.sounds,'ETA');assert.equal(safe.cooldown,6);assert.equal(safe.active.singles.E,2);
});

test('wrong typed letters stay remembered after Backspace, while deletion shifts and unheard input add no mistakes',()=>{
  const session=createCopySession(timeline('KR',{wpm:30,farnsworth:15}),1000),now=session.characters.at(-1).endsAt+300;
  recordCopyInput(session,'R',now);recordCopyInput(session,'',now+10);recordCopyInput(session,'KR',now+20);
  assert.deepEqual(session.mistakes.filter(Boolean),[{expected:'K',actual:'R'}]);
  const before=structuredClone(session.mistakes);recordCopyInput(session,'R',now+30);assert.deepEqual(session.mistakes,before,'Backspace is not a new mistake in the shifted suffix');
  const early=createCopySession(timeline('KR',{wpm:30,farnsworth:15}),1000);recordCopyInput(early,'RK',999);assert.equal(early.mistakes.some(Boolean),false);
  assert.deepEqual(sanitizeMistakes([{expected:'K',actual:'<script>'},{expected:'X',actual:'K'}],'KR'),[null,null]);
});

test('corrected first guesses record confusion and weak letters without clean or speed credit, including reload',()=>{
  const state=newState(),p=state.profiles[0];p.settings=sanitizeSettings({...p.settings,courseLevel:99});
  startRound(p,'CUL');Object.assign(p.round,{heard:true,plays:1,attempts:1,firstGuess:'CUL',responseTimes:[100,100,100],firstResponseTimes:[null,100,100],mistakes:[{expected:'C',actual:'K'}]});
  const q=importState(JSON.stringify(state)).profiles[0];
  assert.deepEqual(copyResponses(q.round),[null,100,100]);assert.equal(recordFirstReview(q),true);
  assert.equal(q.review.sounds.C.correct,0);assert.equal(q.review.sounds.C.confusions.K,1);
  assert.equal(q.review.sounds.U.correct,1);
  const result=finishRound(q,{solved:true});assert.equal(result.clean,false);assert.equal(result.quick,false);
  assert.deepEqual(q.stats.characters.C,{seen:1,correct:0});assert.deepEqual(q.stats.characters.U,{seen:1,correct:1});
  assert.deepEqual(q.stats.mastery[practiceKey(q.settings)].recognition,[null,100,100]);
  assert.equal(q.review.sounds.C.seen,1,'first submission and finish do not duplicate the edit observation');
  q.round.plays=2;
  assert.deepEqual(copyResponses(q.round),[100,100,100],'a replay displays fresh timing while the first-listen correction stays recorded');
  assert.deepEqual(q.round.firstResponseTimes,[null,100,100]);
});

test('recent recognition errors sync once while each device retains its unfinished focus cursor',()=>{
  const base=learner(),local=structuredClone(base),remote=structuredClone(base);
  for(let i=0;i<3;i++)observe(local,'K','R');beginFocus(local,'KR');
  observe(remote,'E');
  const merged=mergeProgress(base,local,remote);assert.deepEqual(merged.review.sounds.K.recent,[false,false,false]);
  assert.equal(automaticFocus(merged,'K','R'),true);assert.equal(syncProfile(local).focus.active,null);
  assert.equal(syncProfile(local).round,null);assert.deepEqual(mergeProgress(local,local,merged).review.sounds.K.recent,[false,false,false]);
});

test('typing errors mark a sound immediately, survive an unfinished reload/replay, and never count twice',()=>{
  const state=newState(),p=state.profiles[0];p.settings=sanitizeSettings({...p.settings,courseLevel:99});
  startRound(p,'CUL');Object.assign(p.round,{plays:1,heard:true,mistakes:[{expected:'C',actual:'K'}]});
  assert.equal(recordTypedMistakes(p),true);assert.equal(recordTypedMistakes(p),false);
  assert.equal(p.review.copies,0);assert.equal(p.review.sounds.C.seen,1);assert.equal(p.review.sounds.C.confusions.K,1);
  const q=importState(JSON.stringify(state)).profiles[0];assert.deepEqual(q.round.typedReviewed,['C']);
  Object.assign(q.round,{plays:2,assisted:true,firstGuess:'CUL',attempts:1});finishRound(q,{solved:true});
  assert.equal(q.review.sounds.C.seen,1);assert.equal(q.review.sounds.C.correct,0);
  const invalid=structuredClone(state);invalid.profiles[0].round.typedReviewed=['E','<script>'];
  assert.deepEqual(importState(JSON.stringify(invalid)).profiles[0].round.typedReviewed,[]);
});
