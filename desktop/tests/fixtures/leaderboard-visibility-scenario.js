(async () => {
  const get = id => document.getElementById(id);
  const open = () => get('open-progress').click();
  const close = () => get('progress-dialog').querySelector('[data-close]').click();
  const expect = (ok, message) => { if (!ok) throw Error(message); };
  async function wait(check, message) {
    for (let i=0; i<150; i++) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve,20));
    }
    throw Error(message + ' · ' + get('listing-state').textContent + ' · ' + testRequests.join(','));
  }
  if (get('guidance-dialog').open) get('guidance-close').click();
  document.querySelector('.main-nav [data-view="journey"]').click();
  await wait(() => get('leaderboard-me').textContent.includes('30 leaderboard XP'), 'Old public score');
  expect(get('leaderboard-me').textContent.includes('70 total XP'), 'Both amounts should be explained before consent');
  open();
  const total = get('use-total-xp'), checkbox = get('list-on-leaderboard');
  expect(!total.hidden && total.textContent.includes('70') && checkbox.checked, 'Legacy sharing offers a separate lifetime choice');
  expect(!testRequests.includes('scores/visibility'), 'Opening progress must preserve the old choice');
  total.click();
  await wait(() => get('listing-state').textContent.includes('70 XP confirmed'), 'Visible lifetime score');
  expect(total.hidden, 'The historical choice should appear only once');
  close();
  get('refresh-leaderboard').click();
  await wait(() => get('leaderboard-me').textContent.includes('70 leaderboard XP'), 'Published lifetime score');
  open(); checkbox.click();
  await wait(() => get('listing-state').textContent.includes('Hidden on the leaderboard'), 'Acknowledged hide');
  close(); get('refresh-leaderboard').click();
  await wait(() => !get('leaderboard-rows').children.length && get('leaderboard-me').textContent.includes('hidden'), 'Public row removed');
  open(); checkbox.click();
  await wait(() => get('listing-state').textContent.includes('70 XP confirmed'), 'Re-show existing high');
  close(); get('refresh-leaderboard').click();
  await wait(() => get('leaderboard-rows').textContent.includes('TEST1'), 'Public row restored');
  expect(!testRequests.includes('private/start'), 'Leaderboard visibility must not link a private profile');
  window.testComplete=true;
})().catch(error => { window.testFailure=error.message; });
