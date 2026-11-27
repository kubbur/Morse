import { BADGES, DEFAULT_SETTINGS, collectedBadges } from './progress.mjs';
import { COURSE_LEVELS, courseStage, practiceKey } from './lessons.mjs';
import { SEND_BADGES, earnedSendBadges } from './sending.mjs';
import { SENDING_LEVELS } from './sending-course.mjs';
import { qslCount, QSL_XP } from './shack-model.mjs';

export const operatorBadges = new Map([...BADGES, ...SEND_BADGES].map(badge => [badge.id, badge]));
const courseKeys = new Map();
for (let level = 1; level <= COURSE_LEVELS; level++) {
  const stage = courseStage(level);
  for (const copyMode of ['flexible', 'head']) {
    const key = practiceKey({...DEFAULT_SETTINGS, courseLevel:level, courseCount:stage.letterCount, level:stage.maxLength, copyMode});
    courseKeys.set(key,level);
  }
}

export function operatorAchievements(profile) {
  const cleared = new Set();
  for (const [key, record] of Object.entries(profile.stats.mastery)) {
    if (record.mastered && courseKeys.has(key)) cleared.add(courseKeys.get(key));
  }
  return {
    listen:cleared.size,
    send:Object.values(profile.sending.records).filter(record => record.mastered).length,
    qsls:qslCount(profile.shack),
    badges:[...collectedBadges(profile), ...earnedSendBadges(profile.sending)].map(badge => badge.id),
  };
}

export function validAchievements(value) {
  if (!value || !Array.isArray(value.badges) || Object.keys(value).length !== 4 ||
      value.badges.length > operatorBadges.size || new Set(value.badges).size !== value.badges.length ||
      !value.badges.every(id => operatorBadges.has(id))) return false;
  return [[value.listen,COURSE_LEVELS], [value.send,SENDING_LEVELS], [value.qsls,1e9 / QSL_XP]]
    .every(([n,max]) => Number.isInteger(n) && n >= 0 && n <= max);
}
